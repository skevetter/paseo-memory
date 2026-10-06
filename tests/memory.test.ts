import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestLatestTurn } from "../server/capture";
import { type Embedder, WordPieceTokenizer, ensureModelFiles, loadStaticEmbedder } from "../server/embedder";
import { MemoryMcpServer, signCaller, verifyCaller } from "../server/mcp";
import { redact } from "../server/redact";
import { MemoryStore, type ProjectRef, ftsQuery } from "../server/store";
import { buildContext, buildSystemPrompt, createTools } from "../server/tools";

const dataRepo: ProjectRef = {
  key: "remote:gitlab.com/h3upperbounds/data/data-team",
  name: "data/data-team",
  rootPath: "/home/u/h3/data-team",
  paseoProjectId: "prj_aaaa",
};
const otherRepo: ProjectRef = {
  key: "remote:github.com/skevetter/devsy",
  name: "skevetter/devsy",
  rootPath: "/Users/u/devsy",
  paseoProjectId: "prj_bbbb",
};

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
});
afterEach(() => store.close());

describe("scopes", () => {
  it("returns project memory only for that project, and global memory everywhere", () => {
    store.save({ title: "Use uv for Python deps", content: "What: uv sync. Why: lockfile.", type: "config", scope: "project", project: dataRepo });
    store.save({ title: "Prefer pnpm in devsy", content: "What: pnpm. Why: workspace.", type: "config", scope: "project", project: otherRepo });
    store.save({ title: "User wants plain sentences", content: "No em dashes", type: "preference", scope: "global", project: dataRepo });

    const inData = store.search({ query: "deps pnpm uv sentences", project: dataRepo }).map((h) => h.title);
    expect(inData).toContain("Use uv for Python deps");
    expect(inData).toContain("User wants plain sentences");
    expect(inData).not.toContain("Prefer pnpm in devsy");

    const globalOnly = store.search({ query: "sentences uv", project: dataRepo, scope: "global" }).map((h) => h.title);
    expect(globalOnly).toEqual(["User wants plain sentences"]);
  });

  it("shares project memory across worktrees because the key is the project, not the cwd", () => {
    store.save({
      title: "GraphQL docs live in docs/gql",
      content: "Where: docs/gql",
      type: "discovery",
      scope: "project",
      project: dataRepo,
      workspaceDir: "/home/u/.paseo/worktrees/abc/apt-6330",
    });
    const fromAnotherWorktree = { ...dataRepo, paseoProjectId: "prj_aaaa" };
    expect(store.search({ query: "graphql docs", project: fromAnotherWorktree })[0]?.title).toBe("GraphQL docs live in docs/gql");
  });

  it("falls back to global when project scope is requested without a project", () => {
    const r = store.save({ title: "t", content: "c", type: "note", scope: "project", project: null });
    expect(r.status).toBe("created");
    expect(store.list({ project: null, scope: "global" })).toHaveLength(1);
  });

  it("resolves a Paseo project id alias to the stable key", () => {
    store.upsertProject(dataRepo);
    expect(store.projectByPaseoId("prj_aaaa")?.key).toBe(dataRepo.key);
  });
});

describe("dedupe and versions", () => {
  it("upserts by topic_key and keeps the previous text", () => {
    const a = store.save({ title: "Auth flow", content: "v1", type: "decision", scope: "project", project: dataRepo, topicKey: "auth/flow" });
    const b = store.save({ title: "Auth flow", content: "v2 uses PKCE", type: "decision", scope: "project", project: dataRepo, topicKey: "auth/flow" });
    expect(a.status).toBe("created");
    expect(b).toEqual({ status: "updated", id: a.id });
    const [row] = store.get([a.id as number]);
    expect(row.content).toBe("v2 uses PKCE");
    expect(row.revision_count).toBe(2);
  });

  it("counts exact duplicates instead of inserting", () => {
    const a = store.save({ title: "Same", content: "Same body", type: "note", scope: "global", project: null });
    const b = store.save({ title: "Same", content: "Same body", type: "note", scope: "global", project: null });
    expect(b).toEqual({ status: "duplicate", id: a.id });
    expect(store.stats().memories).toBe(1);
  });

  it("soft delete hides a memory from search and FTS", () => {
    const a = store.save({ title: "Obsolete rule", content: "old", type: "note", scope: "global", project: null });
    expect(store.delete(a.id as number)).toBe(true);
    expect(store.search({ query: "obsolete", project: null })).toHaveLength(0);
  });

  it("update re-indexes FTS", () => {
    const a = store.save({ title: "Cache layer", content: "redis", type: "decision", scope: "global", project: null });
    store.update(a.id as number, { content: "memcached chosen" });
    expect(store.search({ query: "memcached", project: null })[0]?.id).toBe(String(a.id));
    expect(store.search({ query: "redis", project: null })).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("masks secrets and private blocks before storage", () => {
    const text = redact("key AKIAABCDEFGHIJKLMNOP token=supersecretvalue123 <private>ssn</private> ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).not.toContain("supersecretvalue123");
    expect(text).not.toContain("ssn");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const r = store.save({ title: "creds", content: "password: hunter2hunter2", type: "note", scope: "global", project: null });
    expect(store.get([r.id as number])[0].content).toBe("password: [REDACTED]");
  });
});

describe("sessions and context", () => {
  it("records turn digests per agent and surfaces them in the next agent's context", () => {
    store.save({ title: "Pinned convention", content: "Run make lint before commit", type: "pattern", scope: "project", project: dataRepo, pinned: true });
    store.recordTurn({
      agentId: "agent-1",
      project: dataRepo,
      provider: "claude",
      title: "Fix flaky test",
      workspaceDir: "/w/apt-1",
      userText: "Fix the flaky ingest test",
      assistantText: "Root cause was a timezone assumption; fixed in tests/ingest_test.py",
      files: ["tests/ingest_test.py"],
    });
    const ctx = buildContext({ store, project: dataRepo, budgetChars: 4000 });
    expect(ctx).toContain("Pinned convention");
    expect(ctx).toContain("timezone assumption");
    const prompt = buildSystemPrompt({ context: ctx, project: dataRepo, hasTools: true });
    expect(prompt.startsWith("<paseo-memory>")).toBe(true);
    expect(prompt).toContain("memory_search");
  });

  it("respects the context budget", () => {
    for (let i = 0; i < 40; i++) store.save({ title: `Memory number ${i} about things`, content: "x".repeat(50), type: "note", scope: "project", project: dataRepo });
    expect(buildContext({ store, project: dataRepo, budgetChars: 600 }).length).toBeLessThanOrEqual(600);
  });

  it("digests only the latest turn and ignores reasoning and tool output", () => {
    const d = digestLatestTurn([
      { type: "user_message", text: "old" },
      { type: "assistant_message", text: "old reply" },
      { type: "user_message", text: "new question" },
      { type: "reasoning", text: "secret thoughts" },
      { type: "tool_call", callId: "1", name: "edit", status: "completed", error: null, detail: { type: "edit", filePath: "a.ts" } },
      { type: "assistant_message", text: "final answer" },
    ] as never);
    expect(d).toEqual({ userText: "new question", assistantText: "final answer", files: ["a.ts"] });
  });
});

describe("fts query", () => {
  it("quotes tokens and drops stopwords", () => {
    expect(ftsQuery("What did we decide about the auth-flow?")).toBe('"decide" OR "about" OR "auth-flow"');
    expect(ftsQuery("the a")).toBeNull();
  });
});

describe("mcp server", () => {
  it("authenticates, lists tools, and saves and searches scoped by the signed project", async () => {
    const secret = "test-secret";
    const projects = new Map([[dataRepo.key, dataRepo]]);
    const server = new MemoryMcpServer({
      port: 0 + 46000 + Math.floor(Math.random() * 1000),
      secret,
      instructions: "test",
      tools: createTools({ store, resolveProject: (c) => (c.projectKey ? (projects.get(c.projectKey) ?? null) : null), contextBudget: () => 3000 }),
    });
    await server.start();
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...signCaller(secret, { projectKey: dataRepo.key, agentId: null, provider: "claude" }) };
      const call = async (body: unknown) => {
        const r = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
        return { status: r.status, json: r.status === 202 ? null : ((await r.json()) as Record<string, any>) };
      };
      const unauth = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(unauth.status).toBe(401);
      const browser = await fetch(server.url, { method: "POST", headers: { ...headers, Origin: "http://evil.example" }, body: "{}" });
      expect(browser.status).toBe(403);

      const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      expect(init.json?.result.serverInfo.name).toBe("paseo-memory");
      expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(list.json?.result.tools.map((t: { name: string }) => t.name)).toEqual([
        "memory_search",
        "memory_get",
        "memory_save",
        "memory_update",
        "memory_delete",
        "memory_context",
      ]);
      const saved = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_save", arguments: { title: "Airflow DAG naming", content: "What: dag ids are snake_case", type: "pattern" } } });
      expect(saved.json?.result.content[0].text).toMatch(/^created: #\d+ \(project: data\/data-team\)/);
      const found = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: "airflow dag" } } });
      expect(found.json?.result.content[0].text).toContain("Airflow DAG naming");
      expect(store.list({ project: dataRepo, scope: "project" })).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("rejects tampered tokens", () => {
    const h = signCaller("s", { projectKey: "k", agentId: null, provider: null }).Authorization;
    const [payload, sig] = h.slice(7).split(".");
    const forged = Buffer.from(JSON.stringify({ projectKey: "other" })).toString("base64url");
    expect(verifyCaller("s", h)?.projectKey).toBe("k");
    expect(verifyCaller("s", `Bearer ${forged}.${sig}`)).toBeNull();
    expect(verifyCaller("wrong", `Bearer ${payload}.${sig}`)).toBeNull();
  });
});

// Real model test: uses PASEO_MEMORY_TEST_MODELS or downloads potion-base-8M (30 MB) once.
const modelsDir = process.env.PASEO_MEMORY_TEST_MODELS ?? join(tmpdir(), "paseo-memory-test-models");
describe.skipIf(process.env.PASEO_MEMORY_SKIP_MODEL === "1")("static embeddings", () => {
  let embedder: Embedder;
  beforeEach(async () => {
    const dir = await ensureModelFiles({ modelsDir });
    embedder = loadStaticEmbedder(dir);
  }, 120_000);

  it("produces normalized 256d vectors with sensible similarity", () => {
    const q = embedder.embed("which vector database did we pick?");
    const a = embedder.embed("We chose sqlite-vec for vector search");
    const b = embedder.embed("The CI pipeline uses GitHub Actions");
    expect(embedder.dims).toBe(256);
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(q, q)).toBeCloseTo(1, 4);
    expect(dot(q, a)).toBeGreaterThan(dot(q, b));
  });

  it("finds semantic matches with no keyword overlap and flags near duplicates", () => {
    const s = new MemoryStore({ path: join(mkdtempSync(join(tmpdir(), "pm-")), "m.db"), embedder });
    try {
      s.save({ title: "Picked Postgres for the warehouse", content: "Why: joins and JSONB", type: "decision", scope: "project", project: dataRepo });
      s.save({ title: "Frontend uses React Native", content: "Why: mobile", type: "decision", scope: "project", project: dataRepo });
      const hits = s.search({ query: "which database engine was selected", project: dataRepo });
      expect(hits[0]?.title).toBe("Picked Postgres for the warehouse");
      const dup = s.save({ title: "Picked Postgres for the warehouse", content: "Why: joins and JSONB support", type: "decision", scope: "project", project: dataRepo });
      expect(dup.status).toBe("possible_duplicate");
      const forced = s.save({ title: "Picked Postgres for the warehouse", content: "Why: joins and JSONB support", type: "decision", scope: "project", project: dataRepo, force: true });
      expect(forced.status).toBe("created");
      expect(s.vectorIndex).toBe("blob");
    } finally {
      s.close();
    }
  });

  it("tokenizer matches the reference WordPiece output", () => {
    const tok = new WordPieceTokenizer(JSON.parse(require("node:fs").readFileSync(join(modelsDir, "minishlab__potion-base-8M", "tokenizer.json"), "utf8")));
    expect(tok.encode("Hello, world!").length).toBe(4);
    expect(existsSync(join(modelsDir, "minishlab__potion-base-8M", "model.safetensors"))).toBe(true);
  });
});
