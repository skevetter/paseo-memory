import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FirstPrompts } from "../server/first-prompts";
import { MIN_REVIEW_TURNS, type ReviewPolicy, ReviewScheduler, type ReviewTrigger } from "../server/review";
import { readBranch, taskQuery } from "../server/task-query";
import { parseReviewReply, reviewHeadline, reviewPrompt, reviewPromptDisplay } from "../shared/review";
import { tempDir } from "./helpers";

describe("first prompt cache", () => {
  const directory = (path: string, prompt: string, projectId?: string) => ({
    firstAgentContext: { prompt },
    source: { kind: "directory" as const, path, projectId },
  });
  const worktree = (prompt: string, input: { cwd?: string; projectId?: string; worktreeSlug?: string }) => ({
    firstAgentContext: { prompt },
    source: { kind: "worktree" as const, ...input },
  });
  const agent = (cwd: string, projectId: string | null = null, projectRoot: string | null = null) => ({
    cwd,
    projectId,
    projectRoot,
  });

  it("matches a directory workspace by the agent's cwd, once", () => {
    const prompts = new FirstPrompts(() => 0);
    prompts.remember(directory("/repo", "fix the flaky ingest test"));
    expect(prompts.take(agent("/elsewhere"))).toBeNull();
    expect(prompts.take(agent("/repo/sub"))).toBe("fix the flaky ingest test");
    expect(prompts.take(agent("/repo"))).toBeNull();
  });

  it("matches a new worktree by its slug, then by project, and prefers the stronger match", () => {
    const prompts = new FirstPrompts(() => 0);
    prompts.remember(worktree("by project", { projectId: "prj_1", cwd: "/src/app" }));
    prompts.remember(worktree("by slug", { projectId: "prj_1", cwd: "/src/app", worktreeSlug: "fix-auth" }));
    const cwd = "/home/u/.paseo/worktrees/ab12/fix-auth";
    expect(prompts.take(agent(cwd, "prj_1"))).toBe("by slug");
    expect(prompts.take(agent("/home/u/.paseo/worktrees/ab12/other", "prj_1"))).toBe("by project");
    prompts.remember(worktree("by root", { cwd: "/src/app" }));
    expect(prompts.take(agent("/home/u/.paseo/worktrees/x/y", null, "/src/app"))).toBe("by root");
  });

  it("ignores requests without a prompt and forgets entries after the TTL", () => {
    let now = 0;
    const prompts = new FirstPrompts(() => now);
    prompts.remember({ source: { kind: "directory", path: "/repo" } });
    prompts.remember(directory("/repo", "   "));
    expect(prompts.take(agent("/repo"))).toBeNull();
    prompts.remember(directory("/repo", "late"));
    now = 121_000;
    expect(prompts.take(agent("/repo"))).toBeNull();
  });
});

describe("task query", () => {
  it("uses the first prompt, then the title, branch and folder", () => {
    const names = { title: "Auth refresh", branch: "fix/token-refresh", folder: "data-team" };
    expect(taskQuery({ prompt: "  Why do tokens expire early?  ", ...names })).toEqual({
      query: "Why do tokens expire early?",
      source: "prompt",
    });
    expect(taskQuery({ prompt: null, ...names })).toEqual({
      query: "Auth refresh fix token refresh data team",
      source: "names",
    });
  });

  it("drops generic branches and repeated names, and returns null with nothing to go on", () => {
    expect(taskQuery({ prompt: "", title: null, branch: "main", folder: "kafka-retention" })).toEqual({
      query: "kafka retention",
      source: "names",
    });
    expect(
      taskQuery({ prompt: null, title: null, branch: "kafka-retention", folder: "kafka_retention" }),
    ).toEqual({ query: "kafka retention", source: "names" });
    expect(taskQuery({ prompt: null, title: " ", branch: "master", folder: null })).toBeNull();
  });

  it("reads the branch of a checkout and of a worktree", () => {
    const root = tempDir("pm-branch-");
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    mkdirSync(join(root, "repo", "src"));
    expect(readBranch(join(root, "repo", "src"))).toBe("feature/x");
    mkdirSync(join(root, "gitdirs", "wt"), { recursive: true });
    writeFileSync(join(root, "gitdirs", "wt", "HEAD"), "ref: refs/heads/v1-2-task-recall\n");
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "gitdirs", "wt")}\n`);
    expect(readBranch(join(root, "wt"))).toBe("v1-2-task-recall");
    writeFileSync(join(root, "gitdirs", "wt", "HEAD"), "4f1c0e2\n");
    expect(readBranch(join(root, "wt"))).toBeNull();
  });
});

function fakeScheduler(policy: ReviewPolicy) {
  const timers: { run: () => void; ms: number; live: boolean }[] = [];
  const fired: { agentId: string; trigger: ReviewTrigger }[] = [];
  const scheduler = new ReviewScheduler({
    policy: () => policy,
    fire: (agentId, trigger) => fired.push({ agentId, trigger }),
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const elapse = () => {
    for (const timer of timers.splice(0)) if (timer.live) timer.run();
  };
  return { scheduler, timers, fired, elapse };
}

describe("review scheduler", () => {
  const idle: ReviewPolicy = { mode: "idle", idleMs: 60_000, everyTurns: 8 };

  it("fires once after the idle time when the agent has at least two completed turns", () => {
    const { scheduler, timers, fired, elapse } = fakeScheduler(idle);
    expect(scheduler.turnEnded("a", "completed")).toBe(`1 completed turn, needs ${MIN_REVIEW_TURNS}`);
    expect(scheduler.pending("a")).toBe(false);
    scheduler.turnEnded("a", "completed");
    expect(timers.at(-1)?.ms).toBe(60_000);
    elapse();
    expect(fired).toEqual([{ agentId: "a", trigger: "idle" }]);
    expect(scheduler.turnEnded("a", "completed")).toBe("a review is running");
    elapse();
    expect(fired).toHaveLength(1);
  });

  it("resets the timer when a turn starts and skips after a failed or canceled turn", () => {
    const { scheduler, fired, elapse } = fakeScheduler(idle);
    scheduler.turnEnded("a", "completed");
    scheduler.turnEnded("a", "completed");
    scheduler.turnStarted("a");
    elapse();
    expect(fired).toEqual([]);
    expect(scheduler.turnEnded("a", "failed")).toBe("the last turn failed");
    expect(scheduler.turnEnded("a", "canceled")).toBe("the last turn was canceled");
    elapse();
    expect(fired).toEqual([]);
    scheduler.turnEnded("a", "completed");
    elapse();
    expect(fired).toEqual([{ agentId: "a", trigger: "idle" }]);
  });

  it("needs two new turns after a review, and starts over after a skip without losing count", () => {
    const { scheduler, fired, elapse } = fakeScheduler(idle);
    scheduler.turnEnded("a", "completed");
    scheduler.turnEnded("a", "completed");
    elapse();
    scheduler.reviewStarted("a");
    scheduler.reviewEnded("a");
    scheduler.turnEnded("a", "completed");
    elapse();
    expect(fired).toHaveLength(1);
    scheduler.turnEnded("a", "completed");
    elapse();
    expect(fired).toHaveLength(2);
    scheduler.reviewSkipped("a");
    scheduler.turnEnded("a", "completed");
    elapse();
    expect(fired).toHaveLength(3);
  });

  it("fires every N turns, does nothing when off, and forgets closed agents", () => {
    const turns = fakeScheduler({ mode: "turns", idleMs: 60_000, everyTurns: 3 });
    turns.scheduler.turnEnded("a", "completed");
    expect(turns.scheduler.turnEnded("a", "completed")).toBe("2 of 3 turns");
    turns.scheduler.turnEnded("a", "completed");
    turns.elapse();
    expect(turns.fired).toEqual([{ agentId: "a", trigger: "turns" }]);

    const off = fakeScheduler({ mode: "off", idleMs: 60_000, everyTurns: 3 });
    off.scheduler.turnEnded("a", "completed");
    expect(off.scheduler.turnEnded("a", "completed")).toBe("reviews are off");

    const closed = fakeScheduler(idle);
    closed.scheduler.turnEnded("a", "completed");
    closed.scheduler.turnEnded("a", "completed");
    closed.scheduler.forget("a");
    closed.elapse();
    expect(closed.fired).toEqual([]);
  });
});

describe("review protocol", () => {
  it("marks the prompt with the display mode and states the save limit", () => {
    const prompt = reviewPrompt({ cap: 3, display: "hidden" });
    expect(prompt.split("\n")[0]).toBe("[paseo-memory:review v1 hidden]");
    expect(prompt).toContain("at most 3 durable memories");
    expect(prompt).toContain("memory_search");
    expect(reviewPromptDisplay(prompt)).toBe("hidden");
    expect(reviewPromptDisplay("please review my PR")).toBeNull();
    expect(reviewPrompt({ cap: 0, display: "full" })).toContain("Do not save or update any memory");
  });

  it("parses the summary and the saved and updated ids", () => {
    const reply = parseReviewReply(
      "[paseo-memory:review-reply v1 collapsed]\nSummary: Moved retries to the gateway client.\nThe cap is 3.\nSaved: #14, #15\nUpdated: #9",
    );
    expect(reply).toEqual({
      display: "collapsed",
      summary: "Moved retries to the gateway client. The cap is 3.",
      saved: [14, 15],
      updated: [9],
      nothingToSave: false,
    });
    expect(reviewHeadline(reply)).toBe("Memory review: saved #14, #15, updated #9");
    const nothing = parseReviewReply(
      "[paseo-memory:review-reply v1]\nSummary: Read the docs.\nNothing to save.",
    );
    expect(nothing).toMatchObject({ display: "collapsed", saved: [], updated: [], nothingToSave: true });
    expect(reviewHeadline(nothing)).toBe("Memory review: nothing new");
    expect(parseReviewReply("Summary: x\nSaved: none\nUpdated: none")).toMatchObject({
      saved: [],
      updated: [],
    });
  });
});
