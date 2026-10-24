import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Access } from "../service/access";
import type { Embedder, EmbedKind, TierSpec } from "../service/embedder";
import { checkedIndexTable, indexTarget, modelIndexes } from "../service/model-indexes";
import type { ModelIdentity } from "../service/model-manifest";
import { ownerMutation } from "../service/mutations";
import type { Reranker } from "../service/reranker";
import { openDatabase } from "../service/sqlite";
import { MemoryStore, type SearchInput, type StoreOptions } from "../service/store";
import { modelFingerprint, scopeKey, VectorIndex, type VectorTarget } from "../service/vectors";
import type { MemoryRef, MutationRequest } from "../shared/lifecycle";
import { dataRepo, fixtureModelIdentity, hashEmbedder, hashSpec, otherRepo, owner, tempDir } from "./helpers";

const initialAt = "2026-01-01T00:00:00.000Z";
const dayMs = 86_400_000;
const stores: MemoryStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
});

function setup(options: Omit<StoreOptions, "path"> = {}) {
  const path = join(tempDir("pm-model-execution-"), "memory.db");
  const store = new MemoryStore({
    path,
    now: () => new Date(initialAt),
    indexRetry: { baseMs: 1, maxAttempts: 1 },
    ...options,
    inference: { concurrency: 1, maxPending: 1, now: () => 0, ...options.inference },
  });
  stores.push(store);
  store.upsertProject(dataRepo);
  store.upsertProject(otherRepo);
  const { db } = openDatabase(path);
  databases.push(db);
  return { store, db };
}

function seed(store: MemoryStore, title: string, change: MutationRequest["change"] = {}) {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: randomUUID(),
    operation: "create",
    change: { title, content: `marmot burrow ${title}`, scope: "project", project: dataRepo, ...change },
  });
}

function update(store: MemoryStore, ref: MemoryRef, change: MutationRequest["change"]) {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: randomUUID(),
    operation: "update",
    id: ref.id,
    expectedRevision: ref.revision,
    change,
  });
}

function forget(store: MemoryStore, ref: MemoryRef) {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: randomUUID(),
    operation: "forget",
    id: ref.id,
    expectedRevision: ref.revision,
  });
}

class CallChannel<T> {
  private readonly waiting: T[] = [];
  private readonly readers: ((value: T) => void)[] = [];

  push(value: T): void {
    const reader = this.readers.shift();
    if (reader) reader(value);
    else this.waiting.push(value);
  }

  next(): Promise<T> {
    const value = this.waiting.shift();
    if (value !== undefined) return Promise.resolve(value);
    const { promise, resolve } = Promise.withResolvers<T>();
    this.readers.push(resolve);
    return promise;
  }
}

interface EmbeddingCall {
  kind: EmbedKind;
  release(): Promise<void>;
}

// Controls backend completion only. Hash vectors are deterministic fixtures, not model-quality evidence.
class ControlledEmbedder implements Embedder {
  readonly spec: TierSpec;
  readonly queries: string[][] = [];
  readonly documents: string[][] = [];
  readonly started = new CallChannel<EmbeddingCall>();
  holdQueries = true;
  holdDocuments = false;

  constructor(private readonly inner: Embedder) {
    this.spec = inner.spec;
  }

  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (kind === "query") this.queries.push([...texts]);
    else this.documents.push([...texts]);
    const hold = kind === "query" ? this.holdQueries : this.holdDocuments;
    if (!hold) return this.inner.embed(texts, kind);
    const { promise, resolve, reject } = Promise.withResolvers<Float32Array[]>();
    this.started.push({
      kind,
      release: () => this.inner.embed(texts, kind).then(resolve, reject),
    });
    return promise;
  }
}

function target(store: MemoryStore, ref: MemoryRef): VectorTarget {
  const row = store.getVisible(owner, [ref.id])[0];
  if (!row) throw new Error("The indexed source is missing");
  return {
    id: row.id,
    partition: scopeKey(row.scope, row.project_key),
    hash: row.content_hash,
    generation: row.index_generation,
  };
}

function contents(db: Database, index: { table: string; fingerprint: string }) {
  return {
    vectors: db
      .query<{ memory_id: number; scope_key: string; vector: string }, []>(
        `SELECT memory_id,scope_key,hex(embedding) AS vector FROM ${checkedIndexTable(index.table)} ORDER BY memory_id`,
      )
      .all(),
    metadata: db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM memory_embeddings WHERE index_fingerprint=? ORDER BY memory_id",
      )
      .all(index.fingerprint),
  };
}

function catalogIndex(db: Database, fingerprint: string) {
  const row = modelIndexes(db).find((candidate) => candidate.fingerprint === fingerprint);
  if (!row?.table_name) throw new Error("The model index has no retained vector table");
  return { ...row, table: row.table_name };
}

function recordSession(store: MemoryStore, text: string): void {
  expect(
    store.recordTurn({
      agentId: "model-execution-session",
      project: dataRepo,
      provider: null,
      title: "marmot burrow captured episode",
      workspaceDir: null,
      userText: "marmot burrow source task",
      assistantText: text,
      files: [],
    }),
  ).toBe(true);
}

async function queuedRerank(includeSessions = false) {
  const { store, db } = setup();
  const mutable = seed(store, "mutable source");
  const safe = [seed(store, "safe one"), seed(store, "safe two")] as const;
  if (includeSessions) recordSession(store, "marmot burrow original captured source snapshot");
  store.setEmbedder(hashEmbedder("fixture/queued-rerank", 16));
  await store.indexPending();
  const input: SearchInput = {
    query: "marmot burrow",
    access: Access.agent(dataRepo.key),
    includeSessions,
    rerankMode: "on",
    policyRevision: store.retrievalPolicies.revision,
  };
  await store.search({ ...input, rerankMode: "off" });
  const documents: string[][] = [];
  const reranker: Reranker = {
    model: "fixture/queued-reranker",
    identity: fixtureModelIdentity("fixture/queued-reranker", 1, "reranking"),
    async score(_query, texts) {
      documents.push([...texts]);
      return texts.map(() => 0.5);
    },
  };
  store.setReranker(reranker);
  const slot = Promise.withResolvers<void>();
  const blocker = store.inference.run("document_embedding", () => slot.promise);
  const fallbacks: string[] = [];
  const pending = store.search({ ...input, onFallback: (reason) => fallbacks.push(reason) });
  const refused: string[] = [];
  const lexical = await store.search({ ...input, onFallback: (reason) => refused.push(reason) });
  expect(refused).toContain("inference_overloaded");
  expect(
    lexical
      .filter((hit) => hit.kind === "memory")
      .map((hit) => hit.id)
      .toSorted(),
  ).toEqual(
    [mutable.memoryRef, ...safe.map((entry) => entry.memoryRef)].map((ref) => String(ref.id)).toSorted(),
  );
  expect(store.inference.snapshot()).toMatchObject({ active: 1, pending: 1 });
  expect(documents).toEqual([]);
  return {
    store,
    db,
    mutable,
    safe,
    documents,
    pending,
    fallbacks,
    async release() {
      slot.resolve();
      await blocker;
    },
  };
}

it("keeps a shared query backend alive when only one subscriber aborts", async () => {
  const { store } = setup({ inference: { concurrency: 1, maxPending: 0 } });
  const source = seed(store, "shared query source");
  const backend = new ControlledEmbedder(hashEmbedder("fixture/shared-query", 16));
  store.setEmbedder(backend);
  await store.indexPending();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = store.search({
    query: "marmot burrow",
    access: owner,
    rerankMode: "off",
    signal: firstAbort.signal,
  });
  const call = await backend.started.next();
  const fallbacks: string[] = [];
  const second = store.search({
    query: "marmot burrow",
    access: owner,
    rerankMode: "off",
    signal: secondAbort.signal,
    onFallback: (reason) => fallbacks.push(reason),
  });
  firstAbort.abort();
  expect(await first).toEqual([]);
  expect(store.inference.snapshot()).toMatchObject({
    active: 1,
    pending: 0,
    stages: { query_embedding: { counts: { cancelled: 0, failed: 0 } } },
  });
  await call.release();
  expect((await second).map((hit) => hit.id)).toEqual([String(source.memoryRef.id)]);
  expect(fallbacks).toEqual([]);
  expect(backend.queries).toEqual([["marmot burrow"]]);
  expect(
    (await store.search({ query: "marmot burrow", access: owner, rerankMode: "off" })).map((hit) => hit.id),
  ).toEqual([String(source.memoryRef.id)]);
  expect(backend.queries).toEqual([["marmot burrow"]]);
});

it("retains physical capacity after all query subscribers abort and does not cache their late result", async () => {
  const { store } = setup();
  const source = seed(store, "capacity source");
  const backend = new ControlledEmbedder(hashEmbedder("fixture/cancelled-capacity", 16));
  store.setEmbedder(backend);
  await store.indexPending();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = store.search({
    query: "marmot burrow",
    access: owner,
    signal: firstAbort.signal,
    rerankMode: "off",
  });
  const old = await backend.started.next();
  const second = store.search({
    query: "marmot burrow",
    access: owner,
    signal: secondAbort.signal,
    rerankMode: "off",
  });
  firstAbort.abort();
  secondAbort.abort();
  expect(await Promise.all([first, second])).toEqual([[], []]);
  expect(store.inference.snapshot()).toMatchObject({ active: 1, pending: 0 });
  const barrier = store.inference.run("document_embedding", async () => "physical slot released");
  const fallbacks: string[] = [];
  const lexical = await store.search({
    query: "marmot burrow",
    access: owner,
    rerankMode: "off",
    onFallback: (reason) => fallbacks.push(reason),
  });
  expect(lexical.map((hit) => hit.id)).toEqual([String(source.memoryRef.id)]);
  expect(fallbacks).toContain("inference_overloaded");
  expect(backend.queries).toEqual([["marmot burrow"]]);
  expect(store.inference.snapshot()).toMatchObject({ active: 1, pending: 1 });
  await old.release();
  expect(await barrier).toBe("physical slot released");
  const fresh = store.search({ query: "marmot burrow", access: owner, rerankMode: "off" });
  const current = await backend.started.next();
  expect(backend.queries).toEqual([["marmot burrow"], ["marmot burrow"]]);
  await current.release();
  expect((await fresh).map((hit) => hit.id)).toEqual([String(source.memoryRef.id)]);
  expect(store.inference.snapshot().stages.query_embedding.counts).toEqual({
    completed: 1,
    failed: 0,
    cancelled: 1,
    rejected: 1,
  });
});

it("forgets queued document inputs before dispatch and never repopulates a forgotten query cache", async () => {
  const { store, db } = setup();
  const original = seed(store, "original public source");
  const backend = new ControlledEmbedder(hashEmbedder("fixture/queued-document", 16));
  store.setEmbedder(backend);
  await store.indexPending();
  const pendingQuery = store.search({ query: "marmot burrow", access: owner, rerankMode: "off" });
  const blocked = await backend.started.next();
  const doomed = seed(store, "private doomed document");
  const survivor = seed(store, "new public survivor");
  // The index pass was scheduled synchronously by the mutations above; yield once to enqueue that pass.
  await Promise.resolve();
  expect(store.inference.snapshot()).toMatchObject({ active: 1, pending: 1 });
  expect(forget(store, doomed.memoryRef).status).toBe("forgotten");
  expect(await pendingQuery).toEqual([]);
  expect(store.inference.snapshot().active).toBe(1);
  expect(backend.documents).toEqual([["original public source\nmarmot burrow original public source"]]);
  backend.holdQueries = false;
  await blocked.release();
  await store.indexPending();
  expect(backend.documents).toEqual([
    ["original public source\nmarmot burrow original public source"],
    ["new public survivor\nmarmot burrow new public survivor"],
  ]);
  const hits = await store.search({ query: "marmot burrow", access: owner, rerankMode: "off" });
  expect(hits.map((hit) => hit.id).toSorted()).toEqual(
    [original.memoryRef, survivor.memoryRef].map((ref) => String(ref.id)).toSorted(),
  );
  expect(backend.queries).toEqual([["marmot burrow"], ["marmot burrow"]]);
  expect(db.query("SELECT * FROM memory_embeddings WHERE memory_id=?").all(doomed.memoryRef.id)).toEqual([]);
  expect(store.getVisible(owner, [doomed.memoryRef.id])).toEqual([]);
});

it.each(["correction", "namespace"] as const)(
  "rechecks queued rerank source revisions and grants before a %s reaches the backend",
  async (change) => {
    const fixture = await queuedRerank();
    const { store, mutable, safe } = fixture;
    const corrected = update(
      store,
      mutable.memoryRef,
      change === "correction"
        ? { content: "Unrelated corrected source without the original claim" }
        : { scope: "project", project: otherRepo },
    );
    await fixture.release();
    const hits = await fixture.pending;
    expect(hits.map((hit) => hit.id).toSorted()).toEqual(
      safe.map((entry) => String(entry.memoryRef.id)).toSorted(),
    );
    expect(fixture.documents.map((documents) => documents.toSorted())).toEqual([
      ["safe one\nmarmot burrow safe one", "safe two\nmarmot burrow safe two"].toSorted(),
    ]);
    const fresh = await store.search({
      query: `#${mutable.memoryRef.id}`,
      access: Access.agent(change === "namespace" ? otherRepo.key : dataRepo.key),
    });
    expect(
      fresh.map((hit) => ({ id: hit.id, revision: hit.kind === "memory" ? hit.revision : null })),
    ).toEqual([{ id: String(corrected.memoryRef.id), revision: corrected.memoryRef.revision }]);
  },
);

it("counts obsolete queued rerank work as cancelled and permits a current retry", async () => {
  const fixture = await queuedRerank();
  const { store, mutable, safe } = fixture;
  update(store, mutable.memoryRef, { scope: "project", project: otherRepo });
  update(store, safe[0].memoryRef, { scope: "project", project: otherRepo });
  await fixture.release();
  expect((await fixture.pending).map((hit) => hit.id)).toEqual([String(safe[1].memoryRef.id)]);
  expect(fixture.documents).toEqual([]);
  expect(store.inference.snapshot().stages.rerank.counts).toMatchObject({ cancelled: 1, failed: 0 });
  const replacement = seed(store, "current replacement");
  await store.indexPending();
  const retry = await store.search({
    query: "marmot burrow",
    access: Access.agent(dataRepo.key),
    rerankMode: "on",
  });
  expect(retry.map((hit) => hit.id).toSorted()).toEqual(
    [safe[1].memoryRef, replacement.memoryRef].map((ref) => String(ref.id)).toSorted(),
  );
  expect(store.inference.snapshot().stages.rerank.counts).toMatchObject({
    completed: 1,
    cancelled: 1,
    failed: 0,
  });
});

it("settles queued rerank callers on owner-policy change without sending their documents to the backend", async () => {
  const fixture = await queuedRerank();
  const policy = structuredClone(fixture.store.config.retrievalPolicy);
  Object.assign(policy.profiles.standard, { maxItems: 0, allowedRecordKinds: [] });
  fixture.store.configure({ ...fixture.store.config, retrievalPolicy: policy });
  expect(await fixture.pending).toEqual([]);
  expect(fixture.fallbacks).toContain("policy_changed");
  expect(fixture.documents).toEqual([]);
  expect(fixture.store.inference.snapshot()).toMatchObject({ active: 1, pending: 0 });
  await fixture.release();
  expect(fixture.documents).toEqual([]);
});

it("omits a changed queued session version before reranking while preserving current memory candidates", async () => {
  const fixture = await queuedRerank(true);
  recordSession(fixture.store, "marmot burrow corrected captured source snapshot");
  await fixture.release();
  const hits = await fixture.pending;
  expect(hits.map((hit) => hit.id).toSorted()).toEqual(
    [fixture.mutable, ...fixture.safe].map((entry) => String(entry.memoryRef.id)).toSorted(),
  );
  expect(fixture.documents.map((documents) => documents.toSorted())).toEqual([
    [
      "mutable source\nmarmot burrow mutable source",
      "safe one\nmarmot burrow safe one",
      "safe two\nmarmot burrow safe two",
    ].toSorted(),
  ]);
  expect(
    fixture.store.sessions({ projectKey: dataRepo.key, query: "", limit: 10 }).map((row) => row.last_reply),
  ).toEqual(["marmot burrow corrected captured source snapshot"]);
});

function baseIndexSpec(): TierSpec {
  const spec = hashSpec("fixture/identity-index", 4);
  return {
    ...spec,
    identity: {
      ...spec.identity,
      artifacts: [
        ...spec.identity.artifacts,
        {
          path: "tokenizer.json",
          revision: spec.identity.tokenizerRevision,
          sha256: "1".repeat(64),
          size: 2,
        },
      ],
    },
  };
}

const identityIndexSpec = baseIndexSpec();
const modelRevision = "2".repeat(40);
const tokenizerRevision = "3".repeat(40);
const identityVariants: readonly TierSpec[] = [
  {
    ...identityIndexSpec,
    identity: {
      ...identityIndexSpec.identity,
      modelRevision,
      artifacts: identityIndexSpec.identity.artifacts.map((artifact) =>
        artifact.path === "fixture.bin"
          ? { ...artifact, revision: modelRevision, sha256: "2".repeat(64) }
          : artifact,
      ),
    },
  },
  {
    ...identityIndexSpec,
    identity: {
      ...identityIndexSpec.identity,
      tokenizerRevision,
      artifacts: identityIndexSpec.identity.artifacts.map((artifact) =>
        artifact.path === "tokenizer.json"
          ? { ...artifact, revision: tokenizerRevision, sha256: "3".repeat(64) }
          : artifact,
      ),
    },
  },
  {
    ...identityIndexSpec,
    identity: {
      ...identityIndexSpec.identity,
      runtime: { ...identityIndexSpec.identity.runtime, engineVersion: "fixture-v2" },
    },
  },
  {
    ...identityIndexSpec,
    queryPrefix: "query: ",
    identity: {
      ...identityIndexSpec.identity,
      preprocessing: { ...identityIndexSpec.identity.preprocessing, queryPrefix: "query: " },
    },
  },
  {
    ...identityIndexSpec,
    documentPrefix: "document: ",
    identity: {
      ...identityIndexSpec.identity,
      preprocessing: { ...identityIndexSpec.identity.preprocessing, documentPrefix: "document: " },
    },
  },
];

it("creates separate native indexes for model, tokenizer, runtime and prefix changes without mutating old data", () => {
  const { store, db } = setup();
  const source = seed(store, "identity source");
  const spec = identityIndexSpec;
  const original = new VectorIndex(db, spec, () => initialAt);
  const row = target(store, source.memoryRef);
  const oldVector = new Float32Array([1, 0, 0, 0]);
  original.write(row, oldVector);
  expect(original.finish()).toBe(true);
  const before = contents(db, original);
  const fingerprints = new Set([original.fingerprint]);
  const newVector = new Float32Array([0, 1, 0, 0]);
  for (const variant of identityVariants) {
    const replacement = new VectorIndex(db, variant, () => initialAt);
    expect(replacement.fingerprint).not.toBe(original.fingerprint);
    expect(replacement.table).not.toBe(original.table);
    fingerprints.add(replacement.fingerprint);
    expect(() => original.write(row, newVector)).toThrow();
    expect(contents(db, original)).toEqual(before);
    replacement.write(row, newVector);
    expect(replacement.vector(row.id, row.hash, row.generation)).toEqual(newVector);
    expect(original.vector(row.id, row.hash, row.generation)).toEqual(oldVector);
    expect(replacement.knn(newVector, row.partition, 1).map((neighbor) => neighbor.id)).toEqual([row.id]);
  }
  expect(fingerprints.size).toBe(6);
  expect(
    modelIndexes(db)
      .map((index) => index.fingerprint)
      .toSorted(),
  ).toEqual([...fingerprints].toSorted());
  expect(contents(db, original)).toEqual(before);
});

it("reuses an existing populated native index when identity key and artifact ordering are semantically equal", () => {
  const { store, db } = setup();
  const source = seed(store, "canonical source");
  const spec = baseIndexSpec();
  const original = new VectorIndex(db, spec, () => initialAt);
  const row = target(store, source.memoryRef);
  original.write(row, new Float32Array([1, 0, 0, 0]));
  expect(original.finish()).toBe(true);
  const before = contents(db, original);
  const { engineVersion, ...runtime } = spec.identity.runtime;
  const { queryPrefix, ...preprocessing } = spec.identity.preprocessing;
  const equivalent: ModelIdentity = {
    preprocessing: { queryPrefix, ...preprocessing },
    runtime: { engineVersion, ...runtime },
    artifacts: [...spec.identity.artifacts].reverse().map((artifact) => ({
      size: artifact.size,
      sha256: artifact.sha256,
      revision: artifact.revision,
      path: artifact.path,
    })),
    tokenizerRevision: spec.identity.tokenizerRevision,
    modelRevision: spec.identity.modelRevision,
    model: spec.identity.model,
    schemaVersion: 1,
  };
  const reused = new VectorIndex(db, { ...spec, identity: equivalent }, () => initialAt);
  expect(reused.fingerprint).toBe(original.fingerprint);
  expect(reused.table).toBe(original.table);
  expect(reused.vector(row.id, row.hash, row.generation)).toEqual(new Float32Array([1, 0, 0, 0]));
  expect(modelIndexes(db).map((index) => ({ fingerprint: index.fingerprint, state: index.state }))).toEqual([
    { fingerprint: original.fingerprint, state: "ready" },
  ]);
  expect(contents(db, reused)).toEqual(before);
});

it("retains the previous ready index read-only when a replacement backend fails and serves lexical fallback", async () => {
  const { store, db } = setup();
  const sources = [seed(store, "first retained source"), seed(store, "second retained source")];
  const original = hashEmbedder("fixture/failed-replacement", 16);
  store.setEmbedder(original);
  await store.indexPending();
  await store.search({ query: "marmot burrow", access: owner, rerankMode: "off" });
  const old = catalogIndex(db, modelFingerprint(original.spec));
  const before = contents(db, old);
  const replacement: Embedder = {
    spec: {
      ...original.spec,
      identity: {
        ...original.spec.identity,
        runtime: { ...original.spec.identity.runtime, engineVersion: "fixture-failed-runtime" },
      },
    },
    async embed() {
      throw new Error("Controlled replacement backend failure");
    },
  };
  store.setEmbedder(replacement);
  await store.indexPending();
  const current = catalogIndex(db, modelFingerprint(replacement.spec));
  expect(current.fingerprint).not.toBe(old.fingerprint);
  expect(catalogIndex(db, old.fingerprint).state).toBe("ready");
  expect(current.state).toBe("building");
  expect(contents(db, old)).toEqual(before);
  expect(contents(db, current)).toEqual({ vectors: [], metadata: [] });
  expect(store.resourceStatus().indexes).toMatchObject({
    readyFingerprint: old.fingerprint,
    targetFingerprint: current.fingerprint,
  });
  expect(store.indexHealth()).toMatchObject({ pending: 2, failed: 2, degraded: true });
  const fallbacks: string[] = [];
  const hits = await store.search({
    query: "marmot burrow",
    access: owner,
    rerankMode: "off",
    onFallback: (reason) => fallbacks.push(reason),
  });
  expect(hits.map((hit) => hit.id).toSorted()).toEqual(
    sources.map((source) => String(source.memoryRef.id)).toSorted(),
  );
  expect(fallbacks).toContain("embedding_failed");
  expect(contents(db, old)).toEqual(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("bounds retained indexes by count and prunes expired tables during periodic history upkeep", async () => {
  let at = Date.parse(initialAt);
  const { store, db } = setup({ now: () => new Date(at) });
  const sources = [seed(store, "retained primary"), seed(store, "retained unrelated")];
  const indexes: { fingerprint: string; table: string }[] = [];
  for (let generation = 0; generation < 4; generation++) {
    at = Date.parse(initialAt) + generation * dayMs;
    const embedder = hashEmbedder(`fixture/retention-${generation}`, 8);
    store.setEmbedder(embedder);
    await store.indexPending();
    indexes.push(catalogIndex(db, modelFingerprint(embedder.spec)));
  }
  const [first, second, third, current] = indexes;
  if (!first || !second || !third || !current) throw new Error("Four completed indexes were not created");
  expect(
    modelIndexes(db)
      .map((index) => index.fingerprint)
      .toSorted(),
  ).toEqual([second.fingerprint, third.fingerprint, current.fingerprint].toSorted());
  expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(first.table)).toBeNull();
  expect(
    db.query("SELECT * FROM memory_embeddings WHERE index_fingerprint=?").all(first.fingerprint),
  ).toEqual([]);
  expect(
    modelIndexes(db)
      .filter((index) => index.state === "retired")
      .map((index) => index.fingerprint)
      .toSorted(),
  ).toEqual([second.fingerprint, third.fingerprint].toSorted());
  at = Date.parse(initialAt) + 10 * dayMs;
  store.pruneHistory(365);
  expect(
    modelIndexes(db)
      .map((index) => index.fingerprint)
      .toSorted(),
  ).toEqual([third.fingerprint, current.fingerprint].toSorted());
  expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(second.table)).toBeNull();
  at += dayMs;
  store.pruneHistory(365);
  expect(modelIndexes(db).map((index) => ({ fingerprint: index.fingerprint, state: index.state }))).toEqual([
    { fingerprint: current.fingerprint, state: "ready" },
  ]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(third.table)).toBeNull();
  expect(
    contents(db, current)
      .vectors.map((row) => row.memory_id)
      .toSorted(),
  ).toEqual(sources.map((source) => source.memoryRef.id).toSorted());
  expect(
    store
      .getVisible(
        owner,
        sources.map((source) => source.memoryRef.id),
      )
      .map((row) => row.id)
      .toSorted(),
  ).toEqual(sources.map((source) => source.memoryRef.id).toSorted());
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("invalidates only the writable target on an ordinary correction while retained indexes remain immutable", async () => {
  const { store, db } = setup();
  const source = seed(store, "corrected source");
  const unrelated = seed(store, "uncorrected source");
  const first = hashEmbedder("fixture/ordinary-old", 8);
  store.setEmbedder(first);
  await store.indexPending();
  const old = catalogIndex(db, modelFingerprint(first.spec));
  const before = contents(db, old);
  const second = hashEmbedder("fixture/ordinary-current", 8);
  store.setEmbedder(second);
  await store.indexPending();
  const current = catalogIndex(db, modelFingerprint(second.spec));
  const currentBefore = contents(db, current);
  const corrected = update(store, source.memoryRef, { content: "marmot burrow corrected current content" });
  // Mutation commit is synchronous; observe invalidation before its scheduled index pass runs.
  expect(contents(db, old)).toEqual(before);
  expect(contents(db, current)).toEqual({
    vectors: currentBefore.vectors.filter((row) => row.memory_id !== source.memoryRef.id),
    metadata: currentBefore.metadata.filter((row) => row.memory_id !== source.memoryRef.id),
  });
  await store.indexPending();
  expect(contents(db, old)).toEqual(before);
  const after = contents(db, current);
  const sourceTarget = target(store, corrected.memoryRef);
  expect(after.metadata.find((row) => row.memory_id === source.memoryRef.id)).toMatchObject({
    content_hash: sourceTarget.hash,
    index_generation: sourceTarget.generation,
  });
  expect(after.vectors.filter((row) => row.memory_id === unrelated.memoryRef.id)).toEqual(
    currentBefore.vectors.filter((row) => row.memory_id === unrelated.memoryRef.id),
  );
});

it("hard-forgets every retained index without a target and rejects late writes from an uncooperative old backend", async () => {
  const { store, db } = setup();
  const doomed = seed(store, "forgotten indexed source");
  const unrelated = seed(store, "foreign retained source", { project: otherRepo });
  for (const model of ["fixture/forget-old", "fixture/forget-current"]) {
    store.setEmbedder(hashEmbedder(model, 8));
    await store.indexPending();
  }
  const loading = new ControlledEmbedder(hashEmbedder("fixture/forget-loading", 8));
  loading.holdDocuments = true;
  loading.holdQueries = false;
  store.setEmbedder(loading);
  const inFlight = await loading.started.next();
  expect(inFlight.kind).toBe("document");
  const retained = modelIndexes(db).map((index) => catalogIndex(db, index.fingerprint));
  const before = retained.map((index) => ({ index, data: contents(db, index) }));
  store.setEmbedder(null);
  expect(indexTarget(db)).toBeNull();
  expect(store.resourceStatus().indexes.servingFingerprint).toBeNull();
  expect(forget(store, doomed.memoryRef).status).toBe("forgotten");
  for (const { index, data } of before) {
    expect(contents(db, index)).toEqual({
      vectors: data.vectors.filter((row) => row.memory_id !== doomed.memoryRef.id),
      metadata: data.metadata.filter((row) => row.memory_id !== doomed.memoryRef.id),
    });
  }
  expect(store.inference.snapshot().active).toBe(1);
  await inFlight.release();
  await store.indexPending();
  for (const { index, data } of before) {
    expect(contents(db, index)).toEqual({
      vectors: data.vectors.filter((row) => row.memory_id !== doomed.memoryRef.id),
      metadata: data.metadata.filter((row) => row.memory_id !== doomed.memoryRef.id),
    });
  }
  expect(db.query("SELECT * FROM memories WHERE id=?").all(doomed.memoryRef.id)).toEqual([]);
  expect(db.query("SELECT * FROM memory_revisions WHERE memory_id=?").all(doomed.memoryRef.id)).toEqual([]);
  expect(db.query("SELECT * FROM memory_embeddings WHERE memory_id=?").all(doomed.memoryRef.id)).toEqual([]);
  expect(
    store.getVisible(Access.agent(otherRepo.key), [unrelated.memoryRef.id]).map((row) => row.id),
  ).toEqual([unrelated.memoryRef.id]);
  expect(
    modelIndexes(db)
      .map((index) => index.fingerprint)
      .toSorted(),
  ).toEqual(retained.map((index) => index.fingerprint).toSorted());
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
