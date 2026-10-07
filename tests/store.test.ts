import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildContext, buildSystemPrompt } from "../service/context";
import type { Embedder } from "../service/embedder";
import { redact } from "../service/redact";
import { migrate } from "../service/schema";
import { openDatabase } from "../service/sqlite";
import { MemoryStore } from "../service/store";
import { ftsQuery } from "../service/text";
import { scopeKey, VectorIndex } from "../service/vectors";
import { dataRepo, hashEmbedder, hashSpec, otherRepo, tempDir } from "./helpers";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
});
afterEach(() => store.close());

const titles = (hits: { title: string }[]) => hits.map((h) => h.title);

// Every text maps to one of two orthogonal vectors, chosen by `pick`.
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

  it("reports possible_duplicate from the vector index unless forced or keyed by topic", async () => {
    store.setEmbedder(switchEmbedder("test/switch", () => true));
    const base = { type: "decision", scope: "project" as const, project: dataRepo };
    const first = await store.save({ ...base, title: "Picked Postgres", content: "joins" });
    const near = await store.save({ ...base, title: "Chose Postgres", content: "JSONB" });
    expect(near).toEqual({
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
    // Another project's identical vector is in another partition and is not a duplicate.
    expect(
      (await store.save({ ...base, project: otherRepo, title: "Picked Postgres", content: "joins" })).status,
    ).toBe("created");
  });
});

describe("vector search", () => {
  it("vec0 KNN returns only the requested scope partition", () => {
    const { db } = openDatabase(":memory:");
    migrate(db);
    // The index is exercised alone, without memories rows behind the ids.
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

    // Switching back reuses the kept vectors; an edit drops every model's stale vector.
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
    const ctx = buildContext({ store, project: dataRepo, budgetChars: 4000 });
    expect(ctx).toContain("Pinned convention");
    expect(ctx).toContain("timezone assumption");
    expect(
      buildContext({ store, project: dataRepo, budgetChars: 4000, excludeAgentId: "agent-1" }),
    ).not.toContain("timezone");
    const prompt = buildSystemPrompt({ context: ctx, project: dataRepo, hasTools: true });
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
    expect(buildContext({ store, project: dataRepo, budgetChars: 600 }).length).toBeLessThanOrEqual(600);
  });

  it("prunes session digests past the retention window", () => {
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
    now = new Date("2026-03-01T00:00:00Z");
    timed.recordTurn({ ...turn, agentId: "new" });
    expect(timed.pruneSessions(30)).toBe(1);
    expect(timed.recentSessions(dataRepo.key, 10).map((s) => s.id)).toEqual(["new"]);
    timed.close();
  });
});

describe("fts query", () => {
  it("quotes tokens and drops stopwords", () => {
    expect(ftsQuery("What did we decide about the auth-flow?")).toBe('"decide" OR "about" OR "auth-flow"');
    expect(ftsQuery("the a")).toBeNull();
  });
});
