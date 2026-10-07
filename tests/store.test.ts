import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildContext, buildSystemPrompt } from "../service/context";
import type { Embedder } from "../service/embedder";
import { redact } from "../service/redact";
import { rerankEnabled } from "../service/reranker";
import { migrate } from "../service/schema";
import { openDatabase } from "../service/sqlite";
import { ContentTooLongError, MemoryStore } from "../service/store";
import { ftsQuery } from "../service/text";
import { scopeKey, VectorIndex } from "../service/vectors";
import { DEFAULT_RUNTIME, EMBEDDING_TIERS, MAX_CONTENT_CHARS } from "../shared/service-api";
import { dataRepo, hashEmbedder, hashSpec, otherRepo, tempDir } from "./helpers";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
});
afterEach(() => store.close());

const titles = (hits: { title: string }[]) => hits.map((h) => h.title);

function switchEmbedder(model: string, pick: (text: string) => boolean): Embedder {
  return {
    spec: hashSpec(model, 4),
    async embed(texts) {
      return texts.map((t) => Float32Array.from(pick(t) ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    },
  };
}

describe("scopes", () => {
  it("returns project memory only for that project, and global memory everywhere", async () => {
    await store.save({
      title: "Use uv for Python deps",
      content: "What: uv sync. Why: lockfile.",
      type: "config",
      scope: "project",
      project: dataRepo,
    });
    await store.save({
      title: "Prefer pnpm in devsy",
      content: "What: pnpm. Why: workspace.",
      type: "config",
      scope: "project",
      project: otherRepo,
    });
    await store.save({
      title: "User wants plain sentences",
      content: "No em dashes",
      type: "preference",
      scope: "global",
      project: dataRepo,
    });

    const inData = titles(await store.search({ query: "deps pnpm uv sentences", project: dataRepo }));
    expect(inData).toContain("Use uv for Python deps");
    expect(inData).toContain("User wants plain sentences");
    expect(inData).not.toContain("Prefer pnpm in devsy");
    expect(titles(await store.search({ query: "sentences uv", project: dataRepo, scope: "global" }))).toEqual(
      ["User wants plain sentences"],
    );
  });

  it("shares project memory across worktrees because the key is the project, not the cwd", async () => {
    await store.save({
      title: "GraphQL docs live in docs/gql",
      content: "Where: docs/gql",
      type: "discovery",
      scope: "project",
      project: dataRepo,
      workspaceDir: "/home/u/.paseo/worktrees/abc/apt-6330",
    });
    const fromAnotherWorktree = {
      ...dataRepo,
      rootPath: "/home/u/.paseo/worktrees/xyz/apt-7000",
      paseoProjectId: "prj_cccc",
    };
    expect((await store.search({ query: "graphql docs", project: fromAnotherWorktree }))[0]?.title).toBe(
      "GraphQL docs live in docs/gql",
    );
  });

  it("falls back to global when project scope is requested without a project", async () => {
    const r = await store.save({ title: "t", content: "c", type: "note", scope: "project", project: null });
    expect(r.status).toBe("created");
    expect(store.list({ project: null, scope: "global" })).toHaveLength(1);
  });

  it("resolves a Paseo project id alias and a project key to the stable project", () => {
    store.upsertProject(dataRepo);
    expect(store.projectByPaseoId("prj_aaaa")?.key).toBe(dataRepo.key);
    expect(store.projectByKey(dataRepo.key)?.name).toBe("data/data-team");
    expect(store.projectByPaseoId("prj_missing")).toBeNull();
  });
});

describe("dedupe and versions", () => {
  it("upserts by topic_key and keeps the previous text", async () => {
    const base = {
      title: "Auth flow",
      type: "decision",
      scope: "project" as const,
      project: dataRepo,
      topicKey: "auth/flow",
    };
    const a = await store.save({ ...base, content: "v1" });
    const b = await store.save({ ...base, content: "v2 uses PKCE" });
    expect(a.status).toBe("created");
    expect(b).toEqual({ status: "updated", id: a.id as number });
    const [row] = store.get([a.id as number]);
    expect(row?.content).toBe("v2 uses PKCE");
    expect(row?.revision_count).toBe(2);
  });

  it("counts exact duplicates instead of inserting", async () => {
    const input = {
      title: "Same",
      content: "Same body",
      type: "note",
      scope: "global" as const,
      project: null,
    };
    const a = await store.save(input);
    expect(await store.save(input)).toEqual({ status: "duplicate", id: a.id as number });
    expect(store.stats().memories).toBe(1);
  });

  it("soft delete hides a memory from search and FTS", async () => {
    const a = await store.save({
      title: "Obsolete rule",
      content: "old",
      type: "note",
      scope: "global",
      project: null,
    });
    expect(store.delete(a.id as number)).toBe(true);
    expect(await store.search({ query: "obsolete", project: null })).toHaveLength(0);
    expect(store.delete(a.id as number)).toBe(false);
  });

  it("update re-indexes FTS", async () => {
    const a = await store.save({
      title: "Cache layer",
      content: "redis",
      type: "decision",
      scope: "global",
      project: null,
    });
    store.update(a.id as number, { content: "memcached chosen" });
    expect((await store.search({ query: "memcached", project: null }))[0]?.id).toBe(String(a.id));
    expect(await store.search({ query: "redis", project: null })).toHaveLength(0);
  });

  it("returns the existing memory for a near duplicate of the same type and scope", async () => {
    store.setEmbedder(switchEmbedder("test/switch", () => true));
    const base = { type: "decision", scope: "project" as const, project: dataRepo };
    const first = await store.save({ ...base, title: "Picked Postgres", content: "joins" });
    const near = await store.save({ ...base, title: "Chose Postgres", content: "JSONB" });
    expect(near).toEqual({
      status: "near_duplicate",
      id: first.id as number,
      title: "Picked Postgres",
      similarity: 1,
    });
    expect(store.stats().memories).toBe(1);
    expect(
      await store.save({ ...base, type: "gotcha", title: "Postgres gotcha", content: "vacuum" }),
    ).toEqual({
      status: "possible_duplicate",
      id: null,
      candidates: [{ id: first.id as number, title: "Picked Postgres", similarity: 1 }],
    });
    expect(
      (await store.save({ ...base, title: "Chose Postgres", content: "JSONB", force: true })).status,
    ).toBe("created");
    expect((await store.save({ ...base, title: "Other", content: "x", topicKey: "db/engine" })).status).toBe(
      "created",
    );
    expect(
      (await store.save({ ...base, project: otherRepo, title: "Picked Postgres", content: "joins" })).status,
    ).toBe("created");
  });

  it("rejects content over the hard cap on save and update", async () => {
    const long = "x".repeat(MAX_CONTENT_CHARS + 1);
    const base = { title: "t", type: "note", scope: "global" as const, project: null };
    await expect(store.save({ ...base, content: long })).rejects.toThrow(ContentTooLongError);
    const ok = await store.save({ ...base, content: "x".repeat(MAX_CONTENT_CHARS) });
    expect(() => store.update(ok.id as number, { content: long })).toThrow(/limit is 4000/);
  });
});

describe("vector search", () => {
  it("vec0 KNN returns only the requested scope partition", () => {
    const { db } = openDatabase(":memory:");
    migrate(db);
    db.run("PRAGMA foreign_keys = OFF");
    const index = new VectorIndex(db, hashSpec("test/knn", 4), () => new Date().toISOString());
    const global = scopeKey("global", null);
    const projectA = scopeKey("project", dataRepo.key);
    const projectB = scopeKey("project", otherRepo.key);
    index.write({ id: 1, partition: global, hash: "h1" }, Float32Array.from([1, 0, 0, 0]));
    index.write({ id: 2, partition: projectA, hash: "h2" }, Float32Array.from([1, 0, 0, 0]));
    index.write({ id: 3, partition: projectB, hash: "h3" }, Float32Array.from([1, 0, 0, 0]));
    index.write({ id: 4, partition: projectA, hash: "h4" }, Float32Array.from([0, 1, 0, 0]));
    const query = Float32Array.from([1, 0, 0, 0]);
    expect(index.knn(query, projectA, 10).map((n) => n.id)).toEqual([2, 4]);
    expect(index.knn(query, projectB, 10)).toEqual([{ id: 3, similarity: 1 }]);
    expect(index.knn(query, global, 10).map((n) => n.id)).toEqual([1]);
    expect(index.table).toBe("vec_test_knn_4");
    db.close();
  });

  it("finds memories by vector alone, without leaking other projects", async () => {
    // Every memory and query embeds to the same vector, so only scope filtering can exclude a hit.
    store.setEmbedder(switchEmbedder("test/same", () => true));
    const base = { type: "note", force: true };
    await store.save({ ...base, title: "Mine", content: "aaa", scope: "project", project: dataRepo });
    await store.save({ ...base, title: "Theirs", content: "bbb", scope: "project", project: otherRepo });
    await store.save({ ...base, title: "Shared", content: "ccc", scope: "global", project: null });
    const hits = titles(
      await store.search({ query: "zzzz nothing matches this keyword", project: dataRepo }),
    );
    expect(hits.sort()).toEqual(["Mine", "Shared"]);
  });

  it("fuses keyword and vector ranks: a hit on both lists outranks a single better keyword hit", async () => {
    store.setEmbedder(switchEmbedder("test/fusion", (t) => t.includes("alpha") || t === "zebra"));
    const base = { type: "note", scope: "global" as const, project: null, force: true };
    await store.save({ ...base, title: "Zebra zebra notes", content: "zebra zebra zebra" });
    await store.save({ ...base, title: "Alpha notes", content: "alpha mentions a zebra once" });
    expect(titles(await store.search({ query: "zebra", project: null }))).toEqual([
      "Alpha notes",
      "Zebra zebra notes",
    ]);
  });

  it("boosts pinned memories over equal matches", async () => {
    const base = { type: "note", scope: "global" as const, project: null, content: "kafka topic retention" };
    await store.save({ ...base, title: "Kafka retention A" });
    const pinned = await store.save({ ...base, title: "Kafka retention B", pinned: true });
    expect((await store.search({ query: "kafka retention", project: null }))[0]?.id).toBe(String(pinned.id));
  });
});

describe("embedding tiers in the store", () => {
  it("keeps one vec0 table per model and re-embeds missing vectors after a tier switch", async () => {
    const big = hashEmbedder("test/big", 64);
    const small = hashEmbedder("test/small", 32);
    store.setEmbedder(big);
    for (const n of [1, 2, 3]) {
      await store.save({
        title: `Memory ${n}`,
        content: `body ${n}`,
        type: "note",
        scope: "global",
        project: null,
      });
    }
    store.setEmbedder(small);
    expect(store.pendingEmbeddings()).toBe(3);
    await store.indexPending();
    expect(store.pendingEmbeddings()).toBe(0);
    expect(store.vecTables().map((t) => t.table_name)).toEqual(["vec_test_big_64", "vec_test_small_32"]);
    expect(store.embeddingModels()).toEqual([
      { model: "test/big", dims: 64, count: 3 },
      { model: "test/small", dims: 32, count: 3 },
    ]);

    const callsBefore = big.calls;
    store.setEmbedder(big);
    await store.indexPending();
    expect(big.calls).toBe(callsBefore);
    const id = Number((await store.search({ query: "memory 1", project: null }))[0]?.id);
    store.update(id, { content: "rewritten body" });
    expect(store.pendingEmbeddings()).toBe(1);
    await store.indexPending();
    expect(store.embeddingModels()).toEqual([
      { model: "test/big", dims: 64, count: 3 },
      { model: "test/small", dims: 32, count: 2 },
    ]);
  });

  it("keyword search works while no model is loaded, and saves queue for the indexer", async () => {
    const saved = await store.save({
      title: "Terraform state in S3",
      content: "bucket tf-state",
      type: "config",
      scope: "global",
      project: null,
    });
    expect((await store.search({ query: "terraform", project: null }))[0]?.id).toBe(String(saved.id));
    store.setEmbedder(hashEmbedder());
    await store.indexPending();
    expect(store.pendingEmbeddings()).toBe(0);
  });
});

describe("migration", () => {
  it("upgrades a v0.1 database: keeps memories, drops BLOB vectors, re-embeds in the background", async () => {
    const path = join(tempDir(), "memory.db");
    const { db } = openDatabase(path);
    db.run(`CREATE TABLE projects (key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE memories (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, project_key TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, topic_key TEXT, content_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        revision_count INTEGER NOT NULL DEFAULT 1, duplicate_count INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'agent',
        agent_id TEXT, provider TEXT, workspace_dir TEXT, branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_seen_at TEXT, deleted_at TEXT);
      CREATE TABLE memory_embeddings (memory_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
      INSERT INTO memories (scope, type, title, content, content_hash, created_at, updated_at)
        VALUES ('global', 'note', 'Old memory', 'from v0.1', 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO memory_embeddings VALUES (1, 'minishlab/potion-base-8M', 2, x'0000803f00000000');
      PRAGMA user_version = 1;`);
    db.close();

    const upgraded = new MemoryStore({ path });
    try {
      expect(titles(upgraded.list({ project: null }))).toEqual(["Old memory"]);
      upgraded.setEmbedder(hashEmbedder());
      expect(upgraded.pendingEmbeddings()).toBe(1);
      await upgraded.indexPending();
      expect(upgraded.embeddingModels()).toEqual([{ model: "test/hash", dims: 64, count: 1 }]);
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a v2 database: adds usage and merge columns and the audit tables", () => {
    const path = join(tempDir(), "memory.db");
    const { db } = openDatabase(path);
    // A 1.0 database: today's schema minus everything v3 added.
    migrate(db);
    db.run(`INSERT INTO memories (scope, type, title, content, content_hash, created_at, updated_at)
        VALUES ('global', 'note', 'From 1.0', 'kept', 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      ALTER TABLE memories DROP COLUMN use_count;
      ALTER TABLE memories DROP COLUMN last_used_at;
      ALTER TABLE memories DROP COLUMN merged_into;
      DROP TABLE agent_links;
      DROP TABLE audit_events;
      PRAGMA user_version = 2;`);
    db.close();
    const upgraded = new MemoryStore({ path });
    try {
      const [row] = upgraded.get([1]);
      expect(row).toMatchObject({ title: "From 1.0", use_count: 0, last_used_at: null, merged_into: null });
      upgraded.markUsed([1]);
      expect(upgraded.get([1])[0]?.use_count).toBe(1);
      upgraded.audit.open({ nonce: "n", projectKey: null, provider: "omp", tools: true });
      expect(upgraded.audit.agentFor("n")).toBeNull();
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a v3 database: adds review and usage columns and re-indexes session digests", () => {
    const path = join(tempDir(), "memory.db");
    const { db } = openDatabase(path);
    // A 1.1 database: today's schema minus everything v4 added, with the 1.1 sessions index.
    migrate(db);
    db.run(`DROP TRIGGER sessions_ai; DROP TRIGGER sessions_ad; DROP TRIGGER sessions_au; DROP TABLE sessions_fts;
      DROP TABLE upkeep_dismissed;
      ALTER TABLE memories DROP COLUMN shown_count; ALTER TABLE memories DROP COLUMN opened_count;
      ALTER TABLE memories DROP COLUMN kept_at; ALTER TABLE memories DROP COLUMN archived_at;
      ALTER TABLE sessions DROP COLUMN summary; ALTER TABLE sessions DROP COLUMN outcomes;
      ALTER TABLE sessions DROP COLUMN reviewed_at; ALTER TABLE agent_links DROP COLUMN tools;
      CREATE VIRTUAL TABLE sessions_fts USING fts5(title, first_prompt, last_prompt, last_reply,
        content = 'sessions', content_rowid = 'rowid', tokenize = "porter unicode61 tokenchars '_-./'");
      INSERT INTO memories (scope, type, title, content, content_hash, created_at, updated_at)
        VALUES ('global', 'note', 'From 1.1', 'kept', 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO sessions (id, agent_id, last_reply, turns, started_at, updated_at)
        VALUES ('a1', 'a1', 'Fixed the flaky test.', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO agent_links (nonce, agent_id, created_at) VALUES ('n1', 'a1', '2026-01-01T00:00:00Z');
      PRAGMA user_version = 3;`);
    db.close();
    const upgraded = new MemoryStore({ path });
    try {
      expect(upgraded.get([1])[0]).toMatchObject({ shown_count: 0, opened_count: 0, kept_at: null });
      expect(upgraded.sessions({ projectKey: null, query: "test", limit: 5 }).map((s) => s.id)).toEqual([
        "a1",
      ]);
      expect(upgraded.audit.toolNonceFor("a1")).toBe("n1");
      expect(
        upgraded.storeReview({ agentId: "a1", summary: "Pinned the clock in tests.", outcomes: null }),
      ).toBe(true);
      expect(upgraded.sessions({ projectKey: null, query: "clock", limit: 5 })[0]?.summary).toBe(
        "Pinned the clock in tests.",
      );
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a v4 database: rebuilds the keyword index, keeps every memory and its id", async () => {
    const path = join(tempDir(), "memory.db");
    const { db } = openDatabase(path);
    // A 1.2.0 database: today's schema with the memories index that kept "." inside words.
    migrate(db);
    db.run(`DROP TRIGGER memories_ai; DROP TRIGGER memories_ad; DROP TRIGGER memories_au; DROP TABLE memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, topic_key, content = 'memories',
        content_rowid = 'id', tokenize = "porter unicode61 tokenchars '_-./'");
      INSERT INTO memories (id, scope, type, title, content, content_hash, created_at, updated_at, deleted_at) VALUES
        (3, 'global', 'config', 'Config file', 'Settings live in config.ts', 'h3', '2026-01-01', '2026-01-01', NULL),
        (5, 'global', 'note', 'Gone', 'Removed zebra note', 'h5', '2026-01-01', '2026-01-01', '2026-02-01'),
        (7, 'global', 'decision', 'Retries', 'Payments retry three times with backoff.', 'h7', '2026-01-01', '2026-01-01', NULL);
      INSERT INTO memories_fts(rowid, title, content, topic_key)
        SELECT id, title, content, topic_key FROM memories WHERE deleted_at IS NULL;
      PRAGMA user_version = 4;`);
    const keyword = (q: string) =>
      db
        .query<{ rowid: number }, [string]>(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
        .all(q)
        .map((r) => r.rowid);
    expect(keyword('"backoff"')).toEqual([]);
    db.close();
    const upgraded = new MemoryStore({ path });
    try {
      expect(upgraded.get([3, 5, 7]).map((r) => [r.id, r.title])).toEqual([
        [3, "Config file"],
        [7, "Retries"],
      ]);
      expect(titles(await upgraded.search({ query: "backoff", project: null }))).toEqual(["Retries"]);
      expect(titles(await upgraded.search({ query: "config.ts", project: null }))).toEqual(["Config file"]);
      expect(await upgraded.search({ query: "zebra", project: null })).toEqual([]);
      expect(upgraded.detail(5).memory).toBeNull();
      expect(upgraded.stats().memories).toBe(2);
    } finally {
      upgraded.close();
    }
  });
});

describe("redaction", () => {
  it("masks secrets and private blocks before storage", async () => {
    const text = redact(
      "key AKIAABCDEFGHIJKLMNOP token=supersecretvalue123 <private>ssn</private> ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).not.toContain("supersecretvalue123");
    expect(text).not.toContain("ssn");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const r = await store.save({
      title: "creds",
      content: "password: hunter2hunter2",
      type: "note",
      scope: "global",
      project: null,
    });
    expect(store.get([r.id as number])[0]?.content).toBe("password: [REDACTED]");
  });
});

describe("sessions and context", () => {
  it("records turn digests per agent and surfaces them in the next agent's context", async () => {
    await store.save({
      title: "Pinned convention",
      content: "Run make lint before commit",
      type: "pattern",
      scope: "project",
      project: dataRepo,
      pinned: true,
    });
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
    const ctx = buildContext({ store, project: dataRepo });
    expect(ctx.text).toContain("Pinned convention");
    expect(ctx.text).toContain("timezone assumption");
    expect(ctx.sessionIds).toEqual(["agent-1"]);
    expect(buildContext({ store, project: dataRepo, excludeAgentId: "agent-1" }).text).not.toContain(
      "timezone",
    );
    const prompt = buildSystemPrompt({ context: ctx.text, project: dataRepo, hasTools: true });
    expect(prompt.startsWith("<paseo-memory>")).toBe(true);
    expect(prompt).toContain("memory_search");
    const hits = await store.search({ query: "timezone", project: dataRepo, includeSessions: true });
    expect(hits.map((h) => h.kind)).toEqual(["session"]);
  });

  it("respects the context budget", async () => {
    for (let i = 0; i < 40; i++) {
      await store.save({
        title: `Memory number ${i} about things`,
        content: "x".repeat(50),
        type: "note",
        scope: "project",
        project: dataRepo,
      });
    }
    store.configure({ ...DEFAULT_RUNTIME, contextBudgetChars: 600, detailLevel: "summaries" });
    const ctx = buildContext({ store, project: dataRepo });
    expect(ctx.text.length).toBeLessThanOrEqual(600);
    expect(ctx.memoryIds.length).toBeGreaterThan(0);
    for (const id of ctx.memoryIds) expect(ctx.text).toContain(`#${id} [note] Memory number`);
    for (const line of ctx.text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).toMatch(/about things \(just now\): x+$/);
    }
  });
});

describe("context ranking and session capture", () => {
  it("orders the block pinned first, then the project's most used memories", async () => {
    const base = { type: "note", scope: "project" as const, project: dataRepo, content: "body" };
    const rarely = await store.save({ ...base, title: "Rarely used" });
    const often = await store.save({ ...base, title: "Often used" });
    await store.save({ ...base, title: "Pinned one", pinned: true });
    for (let i = 0; i < 5; i++) store.markUsed([often.id as number]);
    const text = buildContext({ store, project: dataRepo }).text;
    const at = (title: string) => text.indexOf(title);
    expect(at("Pinned one")).toBeLessThan(at("Often used"));
    expect(at("Often used")).toBeLessThan(at("Rarely used"));
    expect(store.get([rarely.id as number])[0]?.use_count).toBe(0);
  });

  it("keeps whole words when clipping long memory text", async () => {
    const content = `${"alpha beta gamma ".repeat(40)}omega`;
    await store.save({
      title: "Long pinned",
      content,
      type: "note",
      scope: "global",
      project: null,
      pinned: true,
    });
    const line = buildContext({ store, project: null }).text.split("\n")[1] ?? "";
    expect(line).toMatch(/^- #\d+ \[note\] Long pinned: alpha beta gamma .*(alpha|beta|gamma)…$/);
  });

  it("does not record failed turns", () => {
    const turn = {
      agentId: "agent-f",
      project: dataRepo,
      provider: "omp",
      title: null,
      workspaceDir: null,
      userText: "do the thing",
      files: [],
    };
    expect(store.recordTurn({ ...turn, assistantText: "[System Error] provider exited" })).toBe(false);
    expect(store.recordTurn({ ...turn, assistantText: "   " })).toBe(false);
    expect(store.recordTurn({ ...turn, assistantText: null })).toBe(false);
    expect(store.recentSessions(dataRepo.key, 10)).toEqual([]);
    expect(store.recordTurn({ ...turn, assistantText: "Done: added the flag" })).toBe(true);
    expect(store.recentSessions(dataRepo.key, 10).map((s) => s.last_reply)).toEqual(["Done: added the flag"]);
  });

  it("prunes session digests and audit events past the retention window", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const timed = new MemoryStore({ path: ":memory:", now: () => now });
    const turn = {
      project: dataRepo,
      provider: null,
      title: null,
      workspaceDir: null,
      userText: "q",
      assistantText: "a",
      files: [],
    };
    timed.recordTurn({ ...turn, agentId: "old" });
    timed.audit.open({ nonce: "n-old", projectKey: null, provider: "omp", tools: true });
    timed.audit.record("n-old", { kind: "get", ids: [1], found: [] });
    now = new Date("2026-03-01T00:00:00Z");
    timed.recordTurn({ ...turn, agentId: "new" });
    timed.audit.open({ nonce: "n-new", projectKey: null, provider: "omp", tools: true });
    timed.audit.record("n-new", { kind: "get", ids: [1], found: [] });
    timed.audit.link({ nonce: "n-old", agentId: "a-old", workspaceId: "w", title: null });
    timed.audit.link({ nonce: "n-new", agentId: "a-new", workspaceId: "w", title: null });
    expect(timed.pruneHistory(30)).toEqual({ sessions: 1, audit: 1 });
    expect(timed.recentSessions(dataRepo.key, 10).map((s) => s.id)).toEqual(["new"]);
    expect(timed.audit.workspaceAgents("w", 10).map((a) => a.agentId)).toEqual(["a-new"]);
    timed.close();
  });
});

describe("usage", () => {
  it("counts agent searches in the top five and fetches, but not UI browsing", async () => {
    const base = { type: "note", scope: "global" as const, project: null, force: true };
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(
        (await store.save({ ...base, title: `Kafka note ${i}`, content: `kafka ${"retention ".repeat(i)}` }))
          .id as number,
      );
    }
    await store.search({ query: "kafka", project: null, limit: 10 });
    expect(store.get(ids).every((r) => r.use_count === 0)).toBe(true);
    const hits = await store.search({ query: "kafka", project: null, limit: 10, track: true });
    const used = store
      .get(ids)
      .filter((r) => r.use_count === 1)
      .map((r) => String(r.id));
    expect(used.sort()).toEqual(
      hits
        .slice(0, 5)
        .map((h) => h.id)
        .sort(),
    );
    store.markUsed([ids[6] as number, ids[6] as number]);
    expect(store.get([ids[6] as number])[0]).toMatchObject({
      use_count: 1,
      last_used_at: expect.any(String),
    });
  });

  it("ranks a used memory above an equal unused one", async () => {
    const base = {
      type: "note",
      scope: "global" as const,
      project: null,
      content: "grafana dashboards live here",
    };
    await store.save({ ...base, title: "Grafana A" });
    const b = await store.save({ ...base, title: "Grafana B" });
    for (let i = 0; i < 8; i++) store.markUsed([b.id as number]);
    expect((await store.search({ query: "grafana dashboards", project: null }))[0]?.id).toBe(String(b.id));
  });

  it("lists unpinned memories nobody used or edited for 60 days as stale", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const timed = new MemoryStore({ path: ":memory:", now: () => now });
    const base = { type: "note", scope: "global" as const, project: null, content: "c" };
    const old = await timed.save({ ...base, title: "Old" });
    const usedLater = await timed.save({ ...base, title: "Used later" });
    await timed.save({ ...base, title: "Pinned old", pinned: true });
    now = new Date("2026-02-20T00:00:00Z");
    timed.markUsed([usedLater.id as number]);
    now = new Date("2026-03-15T00:00:00Z");
    expect(timed.list({ project: null, stale: true }).map((h) => h.id)).toEqual([String(old.id)]);
    timed.close();
  });
});

describe("re-ranking", () => {
  const notes = ["Deploy checklist", "Deploy rollback steps", "Deploy freeze dates"];
  const seed = async () => {
    for (const title of notes) {
      await store.save({
        title,
        content: "deploy",
        type: "note",
        scope: "global",
        project: null,
        force: true,
      });
    }
  };

  it("reorders fused candidates by the re-ranker score", async () => {
    await seed();
    const fused = titles(await store.search({ query: "deploy", project: null }));
    const seen: string[][] = [];
    store.setReranker({
      model: "test/reranker",
      async score(_query, docs) {
        seen.push(docs);
        return docs.map((d) =>
          d.startsWith("Deploy freeze") ? 0.9 : d.startsWith("Deploy rollback") ? 0.5 : 0.1,
        );
      },
    });
    const reranked = titles(await store.search({ query: "deploy", project: null, limit: 2 }));
    expect(reranked).toEqual(["Deploy freeze dates", "Deploy rollback steps"]);
    expect(seen[0]).toHaveLength(3);
    store.setReranker(null);
    expect(titles(await store.search({ query: "deploy", project: null }))).toEqual(fused);
  });

  it("keeps the fused order when the re-ranker fails", async () => {
    await seed();
    const fused = titles(await store.search({ query: "deploy", project: null }));
    store.setReranker({
      model: "test/broken",
      score: async () => {
        throw new Error("onnx session failed");
      },
    });
    expect(titles(await store.search({ query: "deploy", project: null }))).toEqual(fused);
  });

  it("is on by default only for the medium and high tiers", () => {
    expect(EMBEDDING_TIERS.map((tier) => rerankEnabled("auto", tier))).toEqual([false, false, true, true]);
    expect(rerankEnabled("on", "zero")).toBe(true);
    expect(rerankEnabled("off", "high")).toBe(false);
  });
});

describe("curation", () => {
  const base = { type: "decision", scope: "project" as const, project: dataRepo };

  it("restores an older version and keeps the replaced text as a version", async () => {
    const a = await store.save({ ...base, title: "Queue", content: "v1 SQS", topicKey: "queue" });
    await store.save({ ...base, title: "Queue", content: "v2 Kafka", topicKey: "queue" });
    const id = a.id as number;
    expect(store.detail(id).versions.map((v) => v.content)).toEqual(["v1 SQS"]);
    expect(store.restore(id, 1)).toBe(true);
    const detail = store.detail(id);
    expect(detail.memory?.content).toBe("v1 SQS");
    expect(detail.versions.map((v) => v.content)).toEqual(["v2 Kafka", "v1 SQS"]);
    expect(store.restore(id, 42)).toBe(false);
  });

  it("merges a duplicate into its target with a pointer and lists duplicates in detail", async () => {
    store.setEmbedder(switchEmbedder("test/merge", () => true));
    const target = (await store.save({ ...base, title: "Picked Postgres", content: "joins" })).id as number;
    const source = (await store.save({ ...base, title: "Chose Postgres", content: "JSONB", force: true }))
      .id as number;
    expect(store.detail(source).duplicates).toEqual([
      { id: target, title: "Picked Postgres", similarity: 1 },
    ]);
    expect(store.merge(source, source).ok).toBe(false);
    expect(store.merge(source, target)).toEqual({ ok: true, message: `Merged #${source} into #${target}.` });
    expect(store.detail(source)).toMatchObject({ memory: null, mergedInto: target });
    expect(store.detail(target).memory?.content).toBe("joins");
    expect(await store.search({ query: "zzz", project: dataRepo })).toHaveLength(1);
  });

  it("moves a memory between scopes", async () => {
    const id = (await store.save({ ...base, title: "Use uv", content: "uv sync" })).id as number;
    expect(() => store.update(id, { scope: "project", project: null })).not.toThrow();
    expect(store.update(id, { scope: "global" })).toBe(true);
    expect(store.list({ project: null, scope: "global" }).map((h) => h.id)).toEqual([String(id)]);
    expect(() => store.update(id, { scope: "project" })).toThrow(/needs a project/);
    expect(store.update(id, { scope: "project", project: otherRepo })).toBe(true);
    expect(store.list({ project: otherRepo, scope: "project" }).map((h) => h.id)).toEqual([String(id)]);
  });
});

describe("audit log", () => {
  it("binds events to the agent only after the nonce is linked", () => {
    store.audit.open({ nonce: "n1", projectKey: dataRepo.key, provider: "omp", tools: true });
    store.audit.record("n1", {
      kind: "search",
      query: "token=supersecretvalue123 deploys",
      scope: "all",
      results: [],
    });
    store.audit.record(null, { kind: "delete", id: 1, ok: false });
    expect(store.audit.agent("agent-1")).toMatchObject({ linked: false, events: [] });
    expect(store.audit.agentFor("n1")).toBeNull();
    store.audit.link({ nonce: "n1", agentId: "agent-1", workspaceId: "ws", title: null });
    expect(store.audit.agentFor("n1")).toBe("agent-1");
    const audit = store.audit.agent("agent-1");
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ kind: "search", summary: "no results" });
    expect(audit.events[0]?.query).not.toContain("supersecretvalue123");
  });
});

describe("fts query", () => {
  it("quotes tokens and drops stopwords", () => {
    expect(ftsQuery("What did we decide about the auth-flow?")).toBe('"decide" OR "about" OR "auth-flow"');
    expect(ftsQuery("the a")).toBeNull();
  });

  it("finds a word that ends a sentence", async () => {
    const saved = await store.save({
      title: "Payment retries",
      content: "Retries are capped at three attempts with backoff.",
      type: "decision",
      scope: "global",
      project: null,
    });
    expect((await store.search({ query: "backoff", project: null })).map((h) => h.id)).toEqual([
      String(saved.id),
    ]);
    expect(store.update(saved.id as number, { content: "Retries use jitter." })).toBe(true);
    expect(await store.search({ query: "backoff", project: null })).toEqual([]);
    expect((await store.search({ query: "jitter", project: null })).map((h) => h.id)).toEqual([
      String(saved.id),
    ]);
  });
});
