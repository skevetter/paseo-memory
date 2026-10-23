import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Access } from "../service/access";
import type { Embedder, EmbedKind } from "../service/embedder";
import type { Reranker } from "../service/reranker";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "../service/schema";
import { openDatabase } from "../service/sqlite";
import { MemoryStore, type StoreOptions } from "../service/store";
import { scopeKey } from "../service/vectors";
import { dataRepo, hashEmbedder, otherRepo, owner, tempDir } from "./helpers";

const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function openStore(path: string, options: Partial<StoreOptions> = {}) {
  const store = new MemoryStore({ path, ...options });
  stores.push(store);
  return store;
}

const newPath = () => join(tempDir("pm-race-"), "memory.db");

// Resolves each call to a promise the test completes; `auto` lets later calls through immediately.
class Gate<T> {
  private readonly waiting: T[] = [];
  private readonly takers: ((item: T) => void)[] = [];
  private auto: ((item: T) => void) | null = null;

  push(item: T): void {
    if (this.auto) this.auto(item);
    else {
      const take = this.takers.shift();
      if (take) take(item);
      else this.waiting.push(item);
    }
  }

  next(): Promise<T> {
    const item = this.waiting.shift();
    if (item) return Promise.resolve(item);
    const { promise, resolve } = Promise.withResolvers<T>();
    this.takers.push(resolve);
    return promise;
  }

  openFrom(release: (item: T) => void): void {
    this.auto = release;
    for (const item of this.waiting.splice(0)) release(item);
  }
}

interface Batch {
  texts: string[];
  release(): void;
}

function deferredEmbedder(model = "test/deferred") {
  const inner = hashEmbedder(model);
  const gate = new Gate<Batch>();
  const embedder: Embedder = {
    spec: inner.spec,
    embed(texts: string[], kind: EmbedKind) {
      const { promise, resolve, reject } = Promise.withResolvers<Float32Array[]>();
      gate.push({ texts, release: () => void inner.embed(texts, kind).then(resolve, reject) });
      return promise;
    },
  };
  return { embedder, gate, releaseEverything: () => gate.openFrom((batch) => batch.release()) };
}

async function seed(store: MemoryStore, title: string, place: Place) {
  const saved = await store.save({
    title,
    content: `marmot burrow ${title}`,
    type: "note",
    scope: place.scope,
    project: place.scope === "project" ? place.project : null,
    force: true,
  });
  return Number(saved.id);
}

type Place = { scope: "global" } | { scope: "project"; project: typeof dataRepo };
const inProject = (project: typeof dataRepo): Place => ({ scope: "project", project });
const everywhere: Place = { scope: "global" };

const patchFor = (place: Place) =>
  place.scope === "global"
    ? { scope: "global" as const }
    : { scope: "project" as const, project: place.project };

const partitionOf = (place: Place) =>
  scopeKey(place.scope, place.scope === "project" ? place.project.key : null);

// Reads the vector partition and freshness metadata through a second connection.
function inspect(path: string, store: MemoryStore, id: number) {
  const { db } = openDatabase(path);
  try {
    const table = store.vecTables().at(-1)?.table_name;
    const partition = table
      ? (db
          .query<{ scope_key: string }, [bigint]>(`SELECT scope_key FROM ${table} WHERE memory_id = ?`)
          .get(BigInt(id))?.scope_key ?? null)
      : null;
    const generations = db
      .query<{ index_generation: number }, [number]>(
        `SELECT index_generation FROM memory_embeddings WHERE memory_id = ?`,
      )
      .all(id)
      .map((row) => row.index_generation);
    const current =
      db
        .query<{ index_generation: number }, [number]>(`SELECT index_generation FROM memories WHERE id = ?`)
        .get(id)?.index_generation ?? 0;
    return { partition, generations, current };
  } finally {
    db.close();
  }
}

describe("in-flight index batches", () => {
  const moves: [string, Place, Place][] = [
    ["project to another project", inProject(dataRepo), inProject(otherRepo)],
    ["project to global", inProject(dataRepo), everywhere],
    ["global to project", everywhere, inProject(dataRepo)],
  ];

  it.each(moves)("never restores a vector to the old namespace: %s", async (_name, from, to) => {
    const path = newPath();
    const store = openStore(path);
    const id = await seed(store, "mover", from);
    const { embedder, gate, releaseEverything } = deferredEmbedder();
    store.setEmbedder(embedder);
    const inFlight = await gate.next();

    expect(store.updateAuthorized(owner, id, patchFor(to))).toBe("ok");
    inFlight.release();
    releaseEverything();
    await store.indexPending();

    const state = inspect(path, store, id);
    expect(state.partition).toBe(partitionOf(to));
    expect(state.generations).toEqual([state.current]);
    expect(store.pendingEmbeddings()).toBe(0);
  });

  it("drops results for a deleted memory and for text corrected while embedding", async () => {
    const path = newPath();
    const store = openStore(path);
    const gone = await seed(store, "doomed", everywhere);
    const edited = await seed(store, "edited", everywhere);
    const { embedder, gate, releaseEverything } = deferredEmbedder();
    store.setEmbedder(embedder);
    const inFlight = await gate.next();
    store.deleteAuthorized(owner, gone);
    store.updateAuthorized(owner, edited, { content: "corrected text about otters" });
    inFlight.release();
    releaseEverything();
    await store.indexPending();

    expect(inspect(path, store, gone).partition).toBeNull();
    const fresh = inspect(path, store, edited);
    expect(fresh.partition).toBe(partitionOf(everywhere));
    expect(fresh.generations).toEqual([fresh.current]);
    expect(store.pendingEmbeddings()).toBe(0);
  });

  it("discards a batch from a model that was switched out and indexes with the new one", async () => {
    const path = newPath();
    const store = openStore(path);
    const id = await seed(store, "switcher", everywhere);
    const first = deferredEmbedder("test/first");
    store.setEmbedder(first.embedder);
    const inFlight = await first.gate.next();
    store.setEmbedder(hashEmbedder("test/second"));
    inFlight.release();
    await store.indexPending();
    expect(store.embeddingModels()).toEqual([{ model: "test/second", dims: 64, count: 1 }]);
    expect(inspect(path, store, id).partition).toBe(partitionOf(everywhere));
  });

  it("reindexes repeatably without duplicate rows", async () => {
    const store = openStore(newPath());
    await seed(store, "one", everywhere);
    await seed(store, "two", inProject(dataRepo));
    store.setEmbedder(hashEmbedder("test/repeat"));
    await store.indexPending();
    store.setEmbedder(hashEmbedder("test/repeat"));
    await store.indexPending();
    expect(store.embeddingModels()).toEqual([{ model: "test/repeat", dims: 64, count: 2 }]);
    expect(store.pendingEmbeddings()).toBe(0);
  });
});

describe("restart during reindex", () => {
  it("keeps lexical access correct and resumes the remaining work", async () => {
    const path = newPath();
    const first = openStore(path);
    const alpha = await seed(first, "restart alpha", inProject(dataRepo));
    await seed(first, "restart beta", inProject(otherRepo));
    await seed(first, "restart global", everywhere);
    const { embedder, gate } = deferredEmbedder();
    first.setEmbedder(embedder);
    const inFlight = await gate.next();
    first.close();
    stores.splice(stores.indexOf(first), 1);
    inFlight.release();

    const second = openStore(path);
    const titles = async (access: Access) =>
      (await second.search({ query: "marmot burrow", access })).map((h) => h.title).sort();
    expect(await titles(Access.agent(otherRepo.key))).toEqual(["restart beta", "restart global"]);
    expect(await titles(Access.agent(null))).toEqual(["restart global"]);
    second.setEmbedder(hashEmbedder("test/deferred"));
    expect(second.pendingEmbeddings()).toBe(3);
    await second.indexPending();
    expect(second.pendingEmbeddings()).toBe(0);
    expect(second.embeddingModels()).toEqual([{ model: "test/deferred", dims: 64, count: 3 }]);
    expect(inspect(path, second, alpha).partition).toBe(partitionOf(inProject(dataRepo)));
  });
});

describe("failed embedding batches", () => {
  function flakyEmbedder(failures: number) {
    const inner = hashEmbedder("test/flaky");
    let calls = 0;
    const embedder: Embedder = {
      spec: inner.spec,
      async embed(texts, kind) {
        calls++;
        if (calls <= failures) throw new Error("model backend unavailable");
        return inner.embed(texts, kind);
      },
    };
    return { embedder, calls: () => calls };
  }

  // Retry timers are collected so the test, not the wall clock, decides when a backoff has elapsed.
  function manualTimers() {
    const queued: { run: () => void; delayMs: number }[] = [];
    return {
      schedule: (run: () => void, delayMs: number) => void queued.push({ run, delayMs }),
      queued,
      async fireAll(store: MemoryStore) {
        while (queued.length > 0) {
          queued.shift()?.run();
          await store.indexPending();
        }
      },
    };
  }

  it("keeps a failed batch pending, backs off exponentially and recovers when the backend does", async () => {
    const timers = manualTimers();
    const store = openStore(newPath(), {
      indexRetry: { baseMs: 100, maxAttempts: 5, schedule: timers.schedule },
    });
    await seed(store, "flaky one", everywhere);
    await seed(store, "flaky two", everywhere);
    const flaky = flakyEmbedder(2);
    store.setEmbedder(flaky.embedder);
    await store.indexPending();

    expect(store.pendingEmbeddings()).toBe(2);
    expect(store.indexHealth()).toMatchObject({ pending: 2, retrying: 2, failed: 0, degraded: true });
    expect(timers.queued.map((t) => t.delayMs)).toEqual([100]);
    timers.queued.shift()?.run();
    await store.indexPending();
    expect(timers.queued.map((t) => t.delayMs)).toEqual([200]);

    await timers.fireAll(store);
    expect(flaky.calls()).toBe(3);
    expect(store.pendingEmbeddings()).toBe(0);
    expect(store.indexHealth()).toEqual({
      pending: 0,
      retrying: 0,
      failed: 0,
      degraded: false,
      lastError: null,
    });
  });

  it("stops after the attempt limit, reports a degraded index, and keeps lexical search", async () => {
    const timers = manualTimers();
    const store = openStore(newPath(), {
      indexRetry: { baseMs: 1, maxAttempts: 3, schedule: timers.schedule },
    });
    await seed(store, "broken one", everywhere);
    const flaky = flakyEmbedder(1000);
    store.setEmbedder(flaky.embedder);
    await store.indexPending();
    await timers.fireAll(store);

    expect(flaky.calls()).toBe(3);
    expect(timers.queued).toEqual([]);
    expect(store.indexHealth()).toEqual({
      pending: 1,
      retrying: 0,
      failed: 1,
      degraded: true,
      lastError: "model backend unavailable",
    });
    const hits = await store.search({ query: "marmot burrow", access: owner });
    expect(hits.map((h) => h.title)).toEqual(["broken one"]);
  });

  it("gives a corrected memory a fresh set of attempts", async () => {
    const timers = manualTimers();
    const store = openStore(newPath(), {
      indexRetry: { baseMs: 1, maxAttempts: 1, schedule: timers.schedule },
    });
    const id = await seed(store, "stubborn", everywhere);
    const flaky = flakyEmbedder(1);
    store.setEmbedder(flaky.embedder);
    await store.indexPending();
    expect(store.indexHealth().failed).toBe(1);
    store.updateAuthorized(owner, id, { content: "rewritten after the failure" });
    await store.indexPending();
    expect(store.pendingEmbeddings()).toBe(0);
    expect(store.indexHealth().failed).toBe(0);
  });
});

describe("search after async work", () => {
  function deferredReranker() {
    const calls = new Gate<{ release: () => void }>();
    const reranker: Reranker = {
      model: "test/deferred-rerank",
      score(_query, docs) {
        const { promise, resolve } = Promise.withResolvers<number[]>();
        calls.push({ release: () => resolve(docs.map((_, i) => 1 - i * 0.1)) });
        return promise;
      },
    };
    return { reranker, calls };
  }

  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("omits a hit whose scope changed while the re-ranker was running", async () => {
    const store = openStore(":memory:");
    const moved = await seed(store, "reranked mover", inProject(dataRepo));
    await seed(store, "reranked peer", inProject(dataRepo));
    const { reranker, calls } = deferredReranker();
    store.setReranker(reranker);
    const search = store.search({ query: "marmot burrow", access: Access.agent(dataRepo.key) });
    const call = await calls.next();
    store.updateAuthorized(owner, moved, patchFor(inProject(otherRepo)));
    call.release();
    expect((await search).map((h) => h.title)).toEqual(["reranked peer"]);
  });

  it("omits a hit deleted while the re-ranker was running", async () => {
    const store = openStore(":memory:");
    const doomed = await seed(store, "reranked doomed", everywhere);
    await seed(store, "reranked survivor", everywhere);
    const { reranker, calls } = deferredReranker();
    store.setReranker(reranker);
    const search = store.search({ query: "marmot burrow", access: owner });
    const call = await calls.next();
    store.deleteAuthorized(owner, doomed);
    call.release();
    expect((await search).map((h) => h.title)).toEqual(["reranked survivor"]);
  });

  it("returns current text, not the text seen when the candidates were fetched", async () => {
    const store = openStore(":memory:");
    const id = await seed(store, "reranked editable", everywhere);
    await seed(store, "reranked other", everywhere);
    const { reranker, calls } = deferredReranker();
    store.setReranker(reranker);
    const search = store.search({ query: "marmot burrow", access: owner });
    const call = await calls.next();
    store.updateAuthorized(owner, id, { title: "reranked corrected title" });
    call.release();
    const titles = (await search).map((h) => h.title);
    expect(titles).toContain("reranked corrected title");
    expect(titles).not.toContain("reranked editable");
  });

  it("drops late results when the caller aborts and does not track usage", async () => {
    const store = openStore(":memory:");
    const id = await seed(store, "abortable", everywhere);
    await seed(store, "abortable peer", everywhere);
    const { reranker, calls } = deferredReranker();
    store.setReranker(reranker);
    const controller = new AbortController();
    const search = store.search({
      query: "marmot burrow",
      access: owner,
      track: true,
      signal: controller.signal,
    });
    const call = await calls.next();
    controller.abort();
    expect(await search).toEqual([]);
    call.release();
    await settle();
    expect(store.getVisible(owner, [id])[0]?.shown_count).toBe(0);
  });

  it("stops before embedding when the signal is already aborted", async () => {
    const store = openStore(":memory:");
    const embedder = hashEmbedder("test/abort");
    store.setEmbedder(embedder);
    await seed(store, "aborted early", everywhere);
    const calls = embedder.calls;
    const hits = await store.search({ query: "marmot burrow", access: owner, signal: AbortSignal.abort() });
    expect(hits).toEqual([]);
    expect(embedder.calls).toBe(calls);
  });
});

async function v5Database() {
  const path = newPath();
  const store = new MemoryStore({ path });
  store.setEmbedder(hashEmbedder("test/mig"));
  const alpha = await seed(store, "kept alpha", inProject(dataRepo));
  await seed(store, "kept beta", inProject(otherRepo));
  await seed(store, "kept global", everywhere);
  store.updateAuthorized(owner, alpha, { content: "marmot burrow kept alpha edited" });
  await store.indexPending();
  store.close();
  const { db } = openDatabase(path);
  db.run(`ALTER TABLE memories DROP COLUMN index_generation; ALTER TABLE memories DROP COLUMN record_revision;
    ALTER TABLE memory_embeddings DROP COLUMN index_generation;
    ALTER TABLE memory_embeddings DROP COLUMN model_fingerprint;
    PRAGMA user_version = 5;`);
  const before = db
    .query<{ id: number; scope: string; project_key: string | null; revision_count: number }, []>(
      `SELECT id, scope, project_key, revision_count FROM memories ORDER BY id`,
    )
    .all();
  db.close();
  return { path, before };
}

interface Migrated {
  id: number;
  scope: string;
  project_key: string | null;
  revision_count: number;
  record_revision: number;
  index_generation: number;
}

describe("schema v6 migration", () => {
  it("keeps every id and namespace, passes foreign_key_check and seeds revisions from revision_count", async () => {
    const { path, before } = await v5Database();
    openStore(path);
    const { db } = openDatabase(path);
    try {
      const after = db
        .query<Migrated, []>(
          `SELECT id, scope, project_key, revision_count, record_revision, index_generation FROM memories ORDER BY id`,
        )
        .all();
      expect(
        after.map(({ id, scope, project_key, revision_count }) => ({
          id,
          scope,
          project_key,
          revision_count,
        })),
      ).toEqual(before);
      expect(after.every((r) => r.record_revision === r.revision_count && r.index_generation === 1)).toBe(
        true,
      );
      expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
      const version = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version;
      expect(version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("marks existing vectors stale, serves lexical search meanwhile and rebuilds in the background", async () => {
    const { path } = await v5Database();
    const store = openStore(path);
    store.setEmbedder(hashEmbedder("test/mig"));
    expect(store.pendingEmbeddings()).toBe(3);
    const titles = (await store.search({ query: "marmot burrow", access: Access.agent(null) })).map(
      (h) => h.title,
    );
    expect(titles).toEqual(["kept global"]);
    await store.indexPending();
    expect(store.pendingEmbeddings()).toBe(0);
  });

  it("writes a consistent backup before migrating", async () => {
    const { path, before } = await v5Database();
    openStore(path);
    const { db } = openDatabase(`${path}.pre-v${SCHEMA_VERSION}-from-v5.bak`);
    try {
      expect(db.query<{ n: number }, []>(`SELECT count(*) AS n FROM memories`).get()?.n).toBe(before.length);
      expect(db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version).toBe(5);
      const columns = db
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('memories')`)
        .all()
        .map((c) => c.name);
      expect(columns).not.toContain("index_generation");
    } finally {
      db.close();
    }
  });

  it("refuses to open a database written by a newer schema and leaves it untouched", () => {
    const path = newPath();
    const { db } = openDatabase(path);
    migrate(db);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    expect(() => migrate(db)).toThrow(`schema v${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => new MemoryStore({ path })).toThrow(SchemaTooNewError);
    const reopened = openDatabase(path);
    const version = reopened.db
      .query<{ user_version: number }, []>(`PRAGMA user_version`)
      .get()?.user_version;
    expect(version).toBe(SCHEMA_VERSION + 1);
    reopened.db.close();
  });
});
