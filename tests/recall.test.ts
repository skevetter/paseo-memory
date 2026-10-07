import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildContext, buildSystemPrompt } from "../service/context";
import type { Embedder } from "../service/embedder";
import { type MemoryHit, MemoryStore, type SaveInput } from "../service/store";
import { findTaskMatches, isTaskMatch } from "../service/task";
import { candidatePairs, runUpkeep, UPKEEP_NONCE, upkeepPairs } from "../service/upkeep";
import { DEFAULT_RUNTIME, type RuntimeConfig } from "../shared/service-api";
import { dataRepo, hashEmbedder, hashSpec } from "./helpers";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
});
afterEach(() => store.close());

const configure = (patch: Partial<RuntimeConfig>) => store.configure({ ...DEFAULT_RUNTIME, ...patch });
const project = { type: "note", scope: "project" as const, project: dataRepo, force: true };
const global = { type: "note", scope: "global" as const, project: null, force: true };
const saveId = async (input: SaveInput) => (await store.save(input)).id as number;
const sameVector = (model: string): Embedder => ({
  spec: hashSpec(model, 4),
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
});

describe("starting memory sections", () => {
  it("caps each section by its own count and lists pinned memories first", async () => {
    for (let i = 0; i < 4; i++)
      await store.save({ ...global, title: `Pinned ${i}`, content: "p", pinned: true });
    for (let i = 0; i < 6; i++) await store.save({ ...project, title: `Project note ${i}`, content: "c" });
    for (let i = 0; i < 5; i++) await store.save({ ...global, title: `Global note ${i}`, content: "g" });
    for (let i = 0; i < 4; i++) {
      store.recordTurn({
        agentId: `agent-${i}`,
        project: dataRepo,
        provider: "omp",
        title: null,
        workspaceDir: null,
        userText: `task ${i}`,
        assistantText: `done ${i}`,
        files: [],
      });
    }
    configure({ maxPinned: 2, projectMemories: 3, globalMemories: 1, recentSessions: 2 });
    const ctx = buildContext({ store, project: dataRepo });
    const count = (prefix: string) => ctx.text.split("\n").filter((l) => l.includes(prefix)).length;
    expect(count("] Pinned ")).toBe(2);
    expect(count("Project note")).toBe(3);
    expect(count("Global note")).toBe(1);
    expect(ctx.sessionIds).toHaveLength(2);
    expect(ctx.text.indexOf("## Pinned")).toBeLessThan(ctx.text.indexOf("## Project memory"));

    configure({ maxPinned: 0, projectMemories: 0, globalMemories: 0, recentSessions: 0 });
    expect(buildContext({ store, project: dataRepo }).text).toBe(`No memories yet for ${dataRepo.name}.`);
  });

  it("shows titles only by default and short summaries when asked, within the budget", async () => {
    await store.save({ ...project, title: "Kafka retention", content: "Seven days on every topic." });
    expect(buildContext({ store, project: dataRepo }).text).toMatch(/\] Kafka retention \(just now\)$/m);
    configure({ detailLevel: "summaries" });
    expect(buildContext({ store, project: dataRepo }).text).toContain(
      "Kafka retention (just now): Seven days",
    );
    configure({ contextBudgetChars: 500, detailLevel: "summaries" });
    for (let i = 0; i < 30; i++)
      await store.save({ ...project, title: `Note ${i}`, content: "x".repeat(80) });
    expect(buildContext({ store, project: dataRepo }).text.length).toBeLessThanOrEqual(500);
  });

  it("appends the extra instructions to the memory instructions", () => {
    const prompt = buildSystemPrompt({
      context: "ctx",
      project: dataRepo,
      hasTools: true,
      extraInstructions: "  Save release decisions as global memories.  ",
    });
    const lines = prompt.split("\n");
    expect(lines.indexOf("Save release decisions as global memories.")).toBeLessThan(lines.indexOf("ctx"));
    expect(
      buildSystemPrompt({ context: "ctx", project: null, hasTools: false, extraInstructions: " " }),
    ).not.toMatch(/\n\n\n/);
  });
});

describe("task matches", () => {
  const seed = async () => {
    store.setEmbedder(hashEmbedder());
    const match = await saveId({
      ...project,
      title: "Gateway limits",
      content: "Payment retries stop after three attempts because the gateway rate limits us",
    });
    await saveId({ ...project, title: "Mobile stack", content: "Frontend uses React Native for the app" });
    return match;
  };
  const task = { query: "why do payment retries stop after three attempts", source: "prompt" as const };

  it("puts memories that match the task above the general lists, without listing them twice", async () => {
    const match = await seed();
    const found = await findTaskMatches({ store, project: dataRepo, task, budgetMs: 1000 });
    expect(found.hits.map((h) => Number(h.id))).toEqual([match]);
    expect(found.note).toBeNull();
    const ctx = buildContext({ store, project: dataRepo, task: found });
    const lines = ctx.text.split("\n");
    expect(lines[0]).toBe("## Relevant to this task");
    expect(lines[1]).toContain(`#${match} [note] Gateway limits`);
    expect(ctx.text.match(/Gateway limits/g)).toHaveLength(1);
    expect(ctx.taskIds).toEqual([match]);
    expect(ctx.text).toContain("## Project memory");
  });

  it("keeps the task section empty below the floor, when turned off, and when the search is slow", async () => {
    await seed();
    const unrelated = { query: "kubernetes ingress annotations", source: "names" as const };
    const none = await findTaskMatches({ store, project: dataRepo, task: unrelated, budgetMs: 1000 });
    expect(none).toMatchObject({ hits: [], note: "No memory was close enough to this task." });
    configure({ taskMatches: 0 });
    expect((await findTaskMatches({ store, project: dataRepo, task, budgetMs: 1000 })).hits).toEqual([]);
    configure({});
    store.setEmbedder({
      spec: hashSpec("test/stalled", 4),
      embed: () => Promise.withResolvers<Float32Array[]>().promise,
    });
    const late = await findTaskMatches({ store, project: dataRepo, task, budgetMs: 1 });
    expect(late.hits).toEqual([]);
    expect(late.note).toContain("took longer than 1 ms");
    expect(buildContext({ store, project: dataRepo, task: late }).text).not.toContain(
      "## Relevant to this task",
    );
  });

  it("needs both the re-ranker and the vector score to clear their floors, and keyword hits only without a model", () => {
    const hit = { relevance: 0.5, similarity: 0.6 } as MemoryHit;
    const floor = { rerank: 0.4, vector: 0.56, keywordOnly: false };
    expect(isTaskMatch(hit, floor)).toBe(true);
    expect(isTaskMatch({ ...hit, relevance: 0.3 }, floor)).toBe(false);
    expect(isTaskMatch({ ...hit, similarity: 0.5 }, floor)).toBe(false);
    expect(isTaskMatch({ ...hit, relevance: null }, floor)).toBe(true);
    const keyword = { ...hit, relevance: null, similarity: null };
    expect(isTaskMatch(keyword, floor)).toBe(false);
    expect(isTaskMatch(keyword, { ...floor, vector: null, keywordOnly: true })).toBe(true);
    expect(isTaskMatch(keyword, { ...floor, vector: null })).toBe(false);
    expect(isTaskMatch({ ...keyword, relevance: 0.5 }, { ...floor, vector: null })).toBe(true);
  });
});

describe("usage feedback", () => {
  const twoEqual = async () => {
    const base = { ...global, content: "grafana dashboards live in the ops folder" };
    return [await saveId({ ...base, title: "Grafana A" }), await saveId({ ...base, title: "Grafana B" })];
  };

  it("demotes memories shown ten times and never opened, and boosts ones that agents open", async () => {
    const [a, b] = (await twoEqual()) as [number, number];
    for (let i = 0; i < 10; i++) store.markShown([a, b]);
    store.markOpened([b]);
    const order = async () =>
      (await store.search({ query: "grafana dashboards", project: null })).map((h) => h.id);
    expect(await order()).toEqual([String(b), String(a)]);
    for (let i = 0; i < 3; i++) store.markOpened([a]);
    expect(await order()).toEqual([String(a), String(b)]);
  });

  it("applies to the starting list and turns off with the setting", async () => {
    await twoEqual();
    const order = async () =>
      (await store.search({ query: "grafana dashboards", project: null })).map((h) => h.id);
    const [first, second] = (await order()).map(Number) as [number, number];
    for (let i = 0; i < 10; i++) store.markShown([first, second]);
    store.markOpened([second]);
    expect(await order()).toEqual([String(second), String(first)]);
    const text = () => buildContext({ store, project: null }).text;
    expect(text().indexOf(`#${second} `)).toBeLessThan(text().indexOf(`#${first} `));
    configure({ usageRanking: false });
    expect(await order()).toEqual([String(first), String(second)]);
  });
});

describe("upkeep", () => {
  it("suggests a merge into the more used memory and merges it automatically when asked", async () => {
    store.setEmbedder(sameVector("test/upkeep"));
    const older = await saveId({ ...project, type: "decision", title: "Picked Postgres", content: "joins" });
    const used = await saveId({ ...project, type: "decision", title: "Chose Postgres", content: "JSONB" });
    store.markShown([used]);
    const { duplicates, contradictions } = upkeepPairs(store, dataRepo);
    expect(contradictions).toEqual([]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ targetId: used, similarity: 1, sameTopic: false });
    expect(runUpkeep(store, "2026-10-07T00:00:00Z")).toMatchObject({ duplicates: 1, merged: 0 });
    expect(store.get([older])).toHaveLength(1);

    configure({ duplicateMerge: "auto" });
    expect(runUpkeep(store, "2026-10-07T00:00:00Z")).toMatchObject({ duplicates: 1, merged: 1 });
    expect(store.detail(older)).toMatchObject({ memory: null, mergedInto: used });
    expect(store.audit.eventsSince(UPKEEP_NONCE, "2026-01-01")).toEqual([
      { kind: "merge", source: older, target: used, similarity: 1, sameTopic: false },
    ]);
    expect(candidatePairs(store)).toEqual([]);
  });

  it("flags differing values as contradictions and never merges them", async () => {
    store.setEmbedder(sameVector("test/contradiction"));
    const a = await saveId({
      ...project,
      type: "config",
      title: "Memory port",
      content: "The service port is 6797",
    });
    const b = await saveId({
      ...project,
      type: "config",
      title: "Memory port",
      content: "The service port is 6798",
    });
    configure({ duplicateMerge: "auto" });
    const { contradictions, duplicates } = upkeepPairs(store, dataRepo);
    expect(duplicates).toEqual([]);
    expect(contradictions).toEqual([
      expect.objectContaining({ values: { a: ["6797"], b: ["6798"] }, similarity: 1 }),
    ]);
    expect(runUpkeep(store, "2026-10-07T00:00:00Z")).toMatchObject({ contradictions: 1, merged: 0 });
    expect(store.get([a, b])).toHaveLength(2);
    store.dismissPair(b, a);
    expect(upkeepPairs(store, dataRepo).contradictions).toEqual([]);
  });

  it("pairs a project and a global memory with the same topic key, and is quiet when off", async () => {
    await store.save({ ...project, title: "Retry cap", content: "3 attempts", topicKey: "billing/retries" });
    await store.save({ ...global, title: "Retry cap", content: "5 attempts", topicKey: "billing/retries" });
    expect(upkeepPairs(store, dataRepo).contradictions).toEqual([
      expect.objectContaining({ sameTopic: true }),
    ]);
    configure({ duplicateMerge: "off" });
    expect(upkeepPairs(store, dataRepo)).toEqual({ duplicates: [], contradictions: [] });
  });

  it("lists unpinned memories untouched for the stale window; keep resets it and archive removes it", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const timed = new MemoryStore({ path: ":memory:", now: () => now });
    try {
      timed.configure({ ...DEFAULT_RUNTIME, staleDays: 30 });
      const old = (await timed.save({ ...global, title: "Old", content: "o" })).id as number;
      const kept = (await timed.save({ ...global, title: "Kept", content: "k" })).id as number;
      await timed.save({ ...global, title: "Pinned", content: "p", pinned: true });
      now = new Date("2026-02-15T00:00:00Z");
      const stale = () => timed.list({ project: null, stale: true }).map((h) => Number(h.id));
      expect(stale()).toEqual([old, kept]);
      expect(timed.keep(kept)).toBe(true);
      expect(stale()).toEqual([old]);
      expect(timed.archive(old)).toBe(true);
      expect(stale()).toEqual([]);
      expect(timed.detail(old)).toMatchObject({ memory: null, archived: true, mergedInto: null });
    } finally {
      timed.close();
    }
  });
});
