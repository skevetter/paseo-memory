import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { digestLatestTurn } from "../server/capture";
import { missingDependencies } from "../server/dependencies";
import { AgentLinks } from "../server/links";
import { findBun, type LocateEnv, LocateError, resolveServicePath } from "../server/locate";
import { contributeServer } from "../server/plugin";
import { type ServiceConfig, ServiceSupervisor, serviceArgs, serviceEnv } from "../server/supervisor";
import { memorySettings } from "../shared/contracts";
import { parseLine, silentLogger } from "../shared/log";
import { isUsableReply } from "../shared/turns";
import { tempDir } from "./helpers";

const repoRoot = join(import.meta.dir, "..");

function fakeFs(
  files: Record<string, string>,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = "darwin",
): LocateEnv {
  return {
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    env,
    home: "/Users/me",
    platform,
  };
}

describe("turn digest", () => {
  it("digests only the latest turn and ignores reasoning and tool output", () => {
    const d = digestLatestTurn([
      { type: "user_message", text: "old" },
      { type: "assistant_message", text: "old reply" },
      { type: "user_message", text: "new question" },
      { type: "reasoning", text: "secret thoughts" },
      {
        type: "tool_call",
        callId: "1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "a.ts" },
      },
      { type: "assistant_message", text: "final answer" },
    ] as never);
    expect(d).toEqual({ userText: "new question", assistantText: "final answer", files: ["a.ts"] });
  });

  it("treats failed, empty and error-banner replies as unusable", () => {
    expect(isUsableReply("Fixed in a.ts")).toBe(true);
    expect(isUsableReply(null)).toBe(false);
    expect(isUsableReply("  \n")).toBe(false);
    expect(isUsableReply("[System Error] provider exited with code 1")).toBe(false);
    expect(isUsableReply("[error] rate limited")).toBe(false);
  });
});

describe("agent links", () => {
  it("claims a nonce exactly and never re-links a claimed agent by match", () => {
    const links = new AgentLinks(() => 0);
    links.add("n1", "/w", "omp");
    links.add("n2", "/w", "omp");
    links.claim("n1", "agent-a");
    expect(links.match("agent-a", "/w", "omp")).toBeNull();
    expect(links.match("agent-b", "/w", "omp")).toBe("n2");
    expect(links.match("agent-c", "/w", "omp")).toBeNull();
  });

  it("matches the oldest nonce with the same cwd and provider inside the window", () => {
    let now = 0;
    const links = new AgentLinks(() => now);
    links.add("old", "/w", "omp");
    now = 60_000;
    links.add("other-cwd", "/x", "omp");
    links.add("other-provider", "/w", "claude");
    links.add("new", "/w", "omp");
    expect(links.match("a1", "/w", "omp")).toBe("old");
    now = 200_000;
    expect(links.match("a2", "/w", "omp")).toBeNull();
  });
});

describe("log lines", () => {
  it("keeps the service's level and strips its tag", () => {
    expect(parseLine("warn [paseo-memory-service] embeddings unavailable", "info")).toEqual({
      level: "warn",
      message: "embeddings unavailable",
    });
    expect(parseLine("Bun panicked", "warn")).toEqual({ level: "warn", message: "Bun panicked" });
  });
});

describe("locating bun", () => {
  it("prefers the setting, then PATH, then Homebrew, then ~/.bun", () => {
    const all = fakeFs(
      {
        "/custom/bun": "",
        "/usr/local/bin/bun": "",
        "/opt/homebrew/bin/bun": "",
        "/Users/me/.bun/bin/bun": "",
      },
      { PATH: "/usr/bin:/usr/local/bin" },
    );
    expect(findBun("/custom/bun", all)).toBe("/custom/bun");
    expect(findBun("", all)).toBe("/usr/local/bin/bun");
    expect(findBun("", fakeFs({ "/opt/homebrew/bin/bun": "", "/Users/me/.bun/bin/bun": "" }))).toBe(
      "/opt/homebrew/bin/bun",
    );
    expect(findBun("", fakeFs({ "/Users/me/.bun/bin/bun": "" }))).toBe("/Users/me/.bun/bin/bun");
  });

  it("finds bun in Linux install locations", () => {
    const linux = (path: string) => fakeFs({ [path]: "" }, {}, "linux");
    expect(findBun("", linux("/home/linuxbrew/.linuxbrew/bin/bun"))).toBe(
      "/home/linuxbrew/.linuxbrew/bin/bun",
    );
    expect(findBun("", linux("/Users/me/.local/bin/bun"))).toBe("/Users/me/.local/bin/bun");
  });

  it("fails with an actionable message when bun is missing", () => {
    expect(() => findBun("", fakeFs({}))).toThrow("bun not found. Install with `brew install bun`.");
    expect(() => findBun("", fakeFs({}, {}, "linux"))).toThrow(
      "bun not found. Install with `curl -fsSL https://bun.sh/install | bash`.",
    );
    expect(() => findBun("/nope/bun", fakeFs({}))).toThrow(LocateError);
  });
});

describe("service dependencies", () => {
  it("lists the runtime packages missing from node_modules", () => {
    const present = new Set(["/p/node_modules/sqlite-vec/package.json"]);
    expect(missingDependencies("/p", (path) => present.has(path))).toEqual(["@huggingface/transformers"]);
    present.add("/p/node_modules/@huggingface/transformers/package.json");
    expect(missingDependencies("/p", (path) => present.has(path))).toEqual([]);
  });
});

describe("locating the service", () => {
  const manifest = JSON.stringify({ id: "paseo-memory" });
  const config = (plugins: Record<string, unknown>) => JSON.stringify({ version: 1, plugins });

  it("derives the entry from the plugin directory recorded in $PASEO_HOME/config.json", () => {
    const fs = fakeFs({
      "/h/config.json": config({
        other: { source: "directory", path: "/src/other", enabled: true },
        "memory-dev": { source: "directory", path: "/src/dev", enabled: true },
        "paseo-memory": { source: "directory", path: "/h/plugins/paseo-memory/abc/checkout", enabled: true },
      }),
      "/src/other/paseo-plugin.json": JSON.stringify({ id: "other" }),
      "/src/other/service/main.ts": "",
      "/src/dev/paseo-plugin.json": manifest,
      "/src/dev/service/main.ts": "",
      "/h/plugins/paseo-memory/abc/checkout/paseo-plugin.json": manifest,
      "/h/plugins/paseo-memory/abc/checkout/service/main.ts": "",
    });
    expect(resolveServicePath("", "/h", fs)).toEqual({
      entry: "/h/plugins/paseo-memory/abc/checkout/service/main.ts",
      root: "/h/plugins/paseo-memory/abc/checkout",
      source: "config.json plugins.paseo-memory.path",
    });
  });

  it("accepts an install under another id and skips disabled installs", () => {
    const fs = fakeFs({
      "/h/config.json": config({
        old: { source: "directory", path: "/src/old", enabled: false },
        "memory-dev": { source: "directory", path: "/src/dev" },
      }),
      "/src/old/paseo-plugin.json": manifest,
      "/src/old/service/main.ts": "",
      "/src/dev/paseo-plugin.json": manifest,
      "/src/dev/service/main.ts": "",
    });
    expect(resolveServicePath("", "/h", fs).root).toBe("/src/dev");
  });

  it("uses the servicePath setting as a directory or an entry file", () => {
    const fs = fakeFs({ "/x/service/main.ts": "" });
    expect(resolveServicePath("/x", "/h", fs).entry).toBe("/x/service/main.ts");
    expect(resolveServicePath("/x/service/main.ts", "/h", fs).root).toBe("/x");
    expect(() => resolveServicePath("/y", "/h", fs)).toThrow(/has no service\/main.ts/);
  });

  it("reports a missing install clearly", () => {
    expect(() => resolveServicePath("", "/h", fakeFs({ "/h/config.json": config({}) }))).toThrow(
      /Set the service directory override/,
    );
    expect(() => resolveServicePath("", "/h", fakeFs({}))).toThrow(/cannot read \/h\/config.json/);
  });
});

describe("service launch", () => {
  it("drops Electron's node switch from the child environment", () => {
    const env = serviceEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", PASEO_HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", PASEO_HOME: "/h" });
  });

  it("passes settings as service flags", () => {
    const config: ServiceConfig = {
      bunPath: "",
      servicePath: "",
      sqlitePath: "/s.dylib",
      tier: "low",
      rerank: "off",
      port: 7000,
      sessionRetentionDays: 7,
    };
    expect(serviceArgs(config, { entry: "/p/service/main.ts", dataDir: "/d", parentPid: 42 })).toEqual([
      "/p/service/main.ts",
      "--data-dir",
      "/d",
      "--port",
      "7000",
      "--tier",
      "low",
      "--rerank",
      "off",
      "--retention-days",
      "7",
      "--parent-pid",
      "42",
      "--sqlite-path",
      "/s.dylib",
    ]);
  });

  it("migrates v1, v2 and v3 settings to v4 with the new defaults", async () => {
    const fromV1 = await memorySettings.migrate?.(
      {
        injectContext: false,
        embeddings: "off",
        duplicateThreshold: 0.9,
        sqliteVecPath: "/x",
        mcpPort: 7001,
      },
      1,
    );
    expect(memorySettings.schema.parse(fromV1)).toMatchObject({
      injectContext: false,
      mcpPort: 7001,
      embeddingTier: "medium",
      rerank: "auto",
    });
    expect(fromV1).not.toHaveProperty("embeddings");
    const fromV2 = await memorySettings.migrate?.({ embeddingTier: "low", bunPath: "/b" }, 2);
    expect(memorySettings.schema.parse(fromV2)).toMatchObject({
      embeddingTier: "low",
      bunPath: "/b",
      rerank: "auto",
    });
    const fromV3 = await memorySettings.migrate?.(
      { contextBudgetChars: 9000, injectContext: false, rerank: "on", mcpPort: 6800 },
      3,
    );
    expect(memorySettings.schema.parse(fromV3)).toEqual({
      ...memorySettings.schema.parse({}),
      contextBudgetChars: 9000,
      injectContext: false,
      rerank: "on",
      mcpPort: 6800,
    });
    expect(memorySettings.schema.parse(fromV3)).toMatchObject({
      taskMatches: 5,
      taskStrictness: "medium",
      reviewTrigger: "idle",
      reviewIdleMinutes: 10,
      reviewDisplay: "collapsed",
      duplicateMerge: "suggest",
      staleDays: 60,
    });
    const parsed = memorySettings.schema.parse(fromV3);
    expect(memorySettings.schema.safeParse({ ...parsed, taskMatches: 51 }).success).toBe(false);
    expect(memorySettings.schema.safeParse({ ...parsed, reviewIdleMinutes: 0 }).success).toBe(false);
  });
});

describe("supervisor", () => {
  let supervisor: ServiceSupervisor | null = null;
  afterEach(async () => {
    await supervisor?.stop();
    supervisor = null;
  });

  const start = (overrides: Partial<ServiceConfig> = {}) => {
    const dataDir = tempDir("pm-supervisor-");
    const models = process.env.PASEO_MEMORY_TEST_MODELS ?? join(tmpdir(), "paseo-memory-test-models");
    mkdirSync(models, { recursive: true });
    symlinkSync(models, join(dataDir, "models"));
    supervisor = new ServiceSupervisor({ dataDir, paseoHome: dataDir, log: silentLogger });
    const config: ServiceConfig = {
      bunPath: process.execPath,
      servicePath: repoRoot,
      sqlitePath: "",
      tier: "zero",
      rerank: "off",
      port: 40000 + Math.floor(Math.random() * 20000),
      sessionRetentionDays: 30,
      ...overrides,
    };
    return { supervisor, ready: supervisor.configure(config) };
  };
  const waitFor = async (check: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(50);
    }
  };

  it("starts the service, proxies calls, and restarts it after a crash", async () => {
    const { supervisor: s } = start();
    await waitFor(() => s.running);
    const status = await s.call("status", {}, 2000);
    expect(status.sqliteVecVersion).toBe("v0.1.9");
    expect(s.snapshot()).toMatchObject({ state: "running", bunPath: process.execPath, restarts: 0 });
    const firstPid = s.snapshot().pid ?? 0;
    process.kill(firstPid, "SIGKILL");
    await waitFor(() => s.snapshot().state === "restarting");
    await waitFor(() => s.running && s.snapshot().pid !== firstPid);
    expect(s.snapshot().restarts).toBe(1);
  }, 30_000);

  it("reports a fatal state when the service refuses to start", async () => {
    const { supervisor: s } = start({ sqlitePath: "/nonexistent/libsqlite3.dylib" });
    await waitFor(() => s.snapshot().state === "fatal");
    expect(s.snapshot().detail).toContain("SQLite override /nonexistent/libsqlite3.dylib does not exist");
    await expect(s.call("status", {}, 500)).rejects.toThrow(/memory service is fatal/);
  }, 30_000);

  it("reports a fatal state when bun is missing", async () => {
    const { supervisor: s } = start({ bunPath: "/nonexistent/bun" });
    await waitFor(() => s.snapshot().state === "fatal");
    expect(s.snapshot().detail).toContain("bun override /nonexistent/bun does not exist");
    expect(s.paths().bun).toEqual({ value: null, source: "override" });
  });
});

describe("agent.create hook", () => {
  it("returns the request unchanged within the deadline when the service is unavailable", async () => {
    const home = tempDir("pm-hook-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, plugins: {} }));
    process.env.PASEO_HOME = home;
    process.env.PASEO_MEMORY_DIR = join(home, "plugin-data");
    const hooks: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {};
    const server = {
      registerSettings: () => ({
        read: async () => ({ status: "ready", revision: "1", values: memorySettings.schema.parse({}) }),
        subscribe: () => () => undefined,
      }),
      before: (name: string, handler: (input: unknown, context: unknown) => Promise<unknown>) => {
        hooks[name] = handler;
      },
      on: () => undefined,
      handle: () => undefined,
    } as unknown as PluginServerContext; // Fakes only what contributeServer calls.
    const cleanup = contributeServer(server);
    // Project lookup never answers, and the service never starts (no install in config.json).
    const hang = () => new Promise(() => undefined);
    const paseo = { workspaces: { list: hang }, projects: { list: hang } };
    const request = { config: { provider: "claude", cwd: "/w" } };
    const started = Date.now();
    const result = await hooks["agent.create"]?.({ request }, { paseo });
    expect(result).toBe(request);
    expect(Date.now() - started).toBeLessThan(2000);
    await cleanup();
  });
});
