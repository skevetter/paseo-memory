import { afterEach, beforeEach, expect, it } from "bun:test";
import { join } from "node:path";
import { Access } from "../service/access";
import type { Embedder } from "../service/embedder";
import { ownerMutation } from "../service/mutations";
import { RetrievalCache } from "../service/retrieval-cache";
import { openDatabase } from "../service/sqlite";
import { MemoryStore } from "../service/store";
import type { MutationRequest, MutationResult } from "../shared/lifecycle";
import { dataRepo, hashEmbedder, hashSpec, otherRepo, owner, tempDir } from "./helpers";

let store: MemoryStore;
let now: Date;
let request = 0;
beforeEach(() => {
  now = new Date("2026-10-01T00:00:00.000Z");
  store = new MemoryStore({ path: join(tempDir("pm-retrieval-"), "memory.db"), now: () => now });
});
afterEach(() => store.close());

function create(title: string, change: MutationRequest["change"] = {}): MutationResult {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: `retrieval-${++request}`,
    operation: "create",
    change: { title, content: "marmot burrow migration guidance", scope: "global", ...change },
  });
}

function update(ref: MutationResult, change: MutationRequest["change"]): MutationResult {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: `retrieval-${++request}`,
    operation: "update",
    id: ref.memoryRef.id,
    expectedRevision: ref.memoryRef.revision,
    change,
  });
}

function inference(model = "test/retrieval") {
  const inner = hashEmbedder(model);
  const queries: string[] = [];
  const documents: string[][] = [];
  const embedder: Embedder = {
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") queries.push(...texts);
      return inner.embed(texts, kind);
    },
  };
  store.setEmbedder(embedder);
  store.setReranker({
    model: "test/retrieval-rerank",
    async score(_query, docs) {
      documents.push([...docs]);
      return docs.map((_, index) => 1 - index / 100);
    },
  });
  return { queries, documents, embedder };
}

it("evicts least-recently-used entries and expires hot entries at their original deadline", () => {
  let time = 0;
  const cache = new RetrievalCache<number>(2, 10, () => time);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3);
  expect(cache.get("b")).toBeUndefined();
  time = 9;
  expect(cache.get("a")).toBe(1);
  time = 10;
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("c")).toBeUndefined();
  cache.set("d", 4);
  cache.clear();
  expect(cache.get("d")).toBeUndefined();
});

it("resolves IDs and small exact title/topic matches without inference, including denied IDs", async () => {
  const fact = create("Use uv for dependencies", { topicKey: "python/dependencies" });
  const hidden = create("Private project rule", { scope: "project", project: otherRepo });
  const candidate = create("Unapproved rule", { state: "candidate" });
  const calls = inference();
  await store.indexPending();
  for (const query of [
    `#${fact.memoryRef.id}`,
    `${fact.memoryRef.id}`,
    "USE UV FOR DEPENDENCIES",
    "python/dependencies",
  ]) {
    expect((await store.search({ access: Access.agent(dataRepo.key), query })).map((hit) => hit.id)).toEqual([
      String(fact.memoryRef.id),
    ]);
  }
  for (const id of [hidden.memoryRef.id, candidate.memoryRef.id, 999999]) {
    expect(await store.search({ access: Access.agent(dataRepo.key), query: `#${id}` })).toEqual([]);
  }
  expect(await store.search({ access: owner, query: `#${fact.memoryRef.id}`, type: "not-the-type" })).toEqual(
    [],
  );
  expect(
    await store.search({ access: owner, query: `#${fact.memoryRef.id}`, recordKinds: ["episode"] }),
  ).toEqual([]);
  expect(calls.queries).toEqual([]);
  expect(calls.documents).toEqual([]);
});

it("bounds hybrid materialization and reranking, and lexical/off modes never invoke disabled inference", async () => {
  const refs = Array.from({ length: 12 }, (_, index) => create(`Migration guideline ${index}`));
  const calls = inference();
  store.setEmbedder({
    spec: calls.embedder.spec,
    async embed(texts, kind) {
      await calls.embedder.embed(texts, kind);
      return texts.map(() =>
        Float32Array.from({ length: calls.embedder.spec.dims }, (_, i) => Number(i === 0)),
      );
    },
  });
  await store.indexPending();
  const hits = await store.search({
    access: owner,
    query: "marmot burrow",
    maxCandidates: 3,
    limit: 20,
    rerankMode: "on",
  });
  expect(hits).toHaveLength(3);
  for (const hit of hits) expect(refs.map((ref) => ref.memoryRef.id)).toContain(Number(hit.id));
  expect(calls.documents.map((docs) => docs.length)).toEqual([3]);
  expect(calls.queries).toEqual(["marmot burrow"]);
  const reasons: string[] = [];
  const lexical = await store.search({
    access: owner,
    query: "marmot burrow",
    mode: "lexical",
    maxCandidates: 2,
    limit: 20,
    rerankMode: "on",
    onFallback: (reason) => reasons.push(reason),
  });
  expect(lexical).toHaveLength(2);
  for (const hit of lexical) expect(refs.map((ref) => ref.memoryRef.id)).toContain(Number(hit.id));
  expect(reasons).toEqual(["lexical_only"]);
  await store.search({ access: owner, query: "marmot burrow", rerankMode: "off" });
  expect(calls.documents.map((docs) => docs.length)).toEqual([3]);
  expect(calls.queries).toEqual(["marmot burrow"]);
  expect(await store.search({ access: owner, query: "marmot burrow", maxCandidates: 0 })).toEqual([]);
});

it("applies namespace and kind SQL predicates before a tiny vector/list candidate limit", async () => {
  for (let index = 0; index < 8; index++)
    create(`Other namespace ${index}`, { scope: "project", project: otherRepo });
  for (let index = 0; index < 8; index++)
    create(`Procedure ${index}`, { recordKind: "procedure_ref", content: `playbook:fixture@${index}` });
  const fact = create("Current scoped fact", { scope: "project", project: dataRepo });
  const embedder: Embedder = {
    spec: hashSpec("test/constant", 4),
    async embed(texts) {
      return texts.map(() => Float32Array.from([1, 0, 0, 0]));
    },
  };
  store.setEmbedder(embedder);
  await store.indexPending();
  expect(
    (
      await store.search({
        access: Access.agent(dataRepo.key),
        scope: "project",
        query: "semantic query with no lexical overlap",
        recordKinds: ["fact"],
        maxCandidates: 1,
        rerankMode: "off",
      })
    ).map((hit) => hit.id),
  ).toEqual([String(fact.memoryRef.id)]);
  expect(
    store.list({ access: Access.agent(dataRepo.key), recordKinds: ["fact"], scope: "project", limit: 1 })[0]
      ?.id,
  ).toBe(String(fact.memoryRef.id));
  expect(store.list({ access: owner, recordKinds: [], limit: 1 })).toEqual([]);
});

it("shares normalized query vectors while keeping candidate grants, kinds and policies isolated", async () => {
  const global = create("Global guidance");
  const local = create("Data guidance", { scope: "project", project: dataRepo });
  const other = create("Other guidance", { scope: "project", project: otherRepo });
  const episode = create("Incident guidance", { recordKind: "episode" });
  const calls = inference();
  await store.indexPending();
  const ids = async (access: Access, query: string, policyRevision = store.retrievalPolicies.revision) =>
    (await store.search({ access, query, recordKinds: ["fact"], rerankMode: "off", policyRevision }))
      .map((hit) => Number(hit.id))
      .sort((a, b) => a - b);
  expect(await ids(Access.agent(dataRepo.key), "  MARMOT  burrow  ")).toEqual([
    global.memoryRef.id,
    local.memoryRef.id,
  ]);
  expect(await ids(Access.agent(otherRepo.key), "marmot burrow")).toEqual([
    global.memoryRef.id,
    other.memoryRef.id,
  ]);
  const oldRevision = store.retrievalPolicies.revision;
  store.configure({ ...store.config, detailLevel: "summaries" });
  expect(await ids(Access.agent(null), "marmot\nburrow")).toEqual([global.memoryRef.id]);
  expect(await ids(Access.agent(null), "marmot burrow", oldRevision)).toEqual([]);
  expect(
    (
      await store.search({
        access: owner,
        query: "marmot burrow",
        recordKinds: ["episode"],
        rerankMode: "off",
      })
    ).map((hit) => Number(hit.id)),
  ).toEqual([episode.memoryRef.id]);
  expect(calls.queries).toEqual(["marmot burrow"]);
});

it("invalidates cached candidates on correction, move, delete and central creation without evicting the query vector", async () => {
  const original = create("Original guidance", { scope: "project", project: dataRepo });
  const peer = create("Peer guidance");
  const calls = inference();
  await store.indexPending();
  const search = () =>
    store.search({ access: Access.agent(dataRepo.key), query: "marmot burrow", rerankMode: "off" });
  await search();
  const generation = store.retrievalGeneration;
  store.markShown([original.memoryRef.id]);
  store.markOpened([original.memoryRef.id]);
  expect(store.retrievalGeneration).toBe(generation);
  const corrected = update(original, {
    title: "Corrected guidance",
    content: "marmot burrow corrected evidence",
  });
  await store.indexPending();
  expect(store.retrievalGeneration).toBeGreaterThan(generation);
  expect((await search()).map((hit) => hit.title)).toContain("Corrected guidance");
  update(corrected, { scope: "project", project: otherRepo });
  await store.indexPending();
  expect((await search()).map((hit) => hit.title)).toEqual(["Peer guidance"]);
  const added = create("Newly discovered guidance");
  await store.indexPending();
  expect((await search()).map((hit) => Number(hit.id)).sort((a, b) => a - b)).toEqual([
    peer.memoryRef.id,
    added.memoryRef.id,
  ]);
  expect(store.deleteAuthorized(owner, peer.memoryRef.id)).toBe("ok");
  expect((await search()).map((hit) => hit.id)).toEqual([String(added.memoryRef.id)]);
  expect(calls.queries).toEqual(["marmot burrow"]);
});

it("detects external connection writes and preserves the durable generation across reopen", async () => {
  const fact = create("Externally changed guidance");
  await store.search({ access: owner, query: "marmot burrow", mode: "lexical" });
  const initial = store.retrievalGeneration;
  const external = openDatabase(store.path).db;
  try {
    external
      .query(
        "UPDATE memories SET content='corrected external text',record_revision=record_revision+1 WHERE id=?",
      )
      .run(fact.memoryRef.id);
  } finally {
    external.close();
  }
  expect(await store.search({ access: owner, query: "marmot burrow", mode: "lexical" })).toEqual([]);
  const advanced = store.retrievalGeneration;
  expect(advanced).toBeGreaterThan(initial);
  const path = store.path;
  store.close();
  store = new MemoryStore({ path, now: () => now });
  expect(store.retrievalGeneration).toBe(advanced);
  expect(
    (await store.search({ access: owner, query: "corrected external", mode: "lexical" }))[0]?.preview,
  ).toBe("corrected external text");
});

it("reconsiders cached IDs at validity boundaries without a write or a wall-clock wait", async () => {
  const expiring = create("Expiring guidance", { validUntil: "2026-10-01T00:00:01.000Z" });
  const future = create("Future guidance", { validFrom: "2026-10-01T00:00:01.000Z" });
  const search = () => store.search({ access: owner, query: "marmot burrow", mode: "lexical" });
  expect((await search()).map((hit) => hit.id)).toEqual([String(expiring.memoryRef.id)]);
  now = new Date("2026-10-01T00:00:01.000Z");
  expect((await search()).map((hit) => hit.id)).toEqual([String(future.memoryRef.id)]);
});

it("does not cache failed query inference and reports degraded results before recovering", async () => {
  const fact = create("Available lexical guidance");
  const inner = hashEmbedder("test/recovery");
  let queryCalls = 0;
  store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query" && ++queryCalls === 1) throw new Error("model temporarily unavailable");
      return inner.embed(texts, kind);
    },
  });
  await store.indexPending();
  const reasons: string[] = [];
  const search = () =>
    store.search({
      access: owner,
      query: "marmot burrow",
      rerankMode: "off",
      onFallback: (reason) => reasons.push(reason),
    });
  expect((await search()).map((hit) => hit.id)).toEqual([String(fact.memoryRef.id)]);
  expect(reasons).toEqual(["embedding_failed"]);
  expect((await search())[0]?.kind).toBe("memory");
  await search();
  expect(queryCalls).toBe(2);
  expect(reasons).toEqual(["embedding_failed"]);
});

it("recovers from failed reranking without fabricating relevance or caching the failure", async () => {
  create("First guidance");
  create("Second guidance");
  let calls = 0;
  store.setReranker({
    model: "test/rerank-recovery",
    async score(_query, docs) {
      if (++calls === 1) throw new Error("reranker temporarily unavailable");
      return docs.map(() => 0.75);
    },
  });
  const reasons: string[] = [];
  const search = () =>
    store.search({ access: owner, query: "marmot burrow", onFallback: (reason) => reasons.push(reason) });
  const degraded = await search();
  expect(degraded.filter((hit) => hit.kind === "memory").map((hit) => hit.relevance)).toEqual([null, null]);
  expect(reasons).toContain("rerank_failed");
  const recovered = await search();
  expect(recovered.filter((hit) => hit.kind === "memory").map((hit) => hit.relevance)).toEqual([0.75, 0.75]);
  expect(calls).toBe(2);
});

it("shares in-flight vectors but cancellation of one reader never tracks or cancels another reader", async () => {
  const fact = create("Shared query guidance");
  const inner = hashEmbedder("test/shared-flight");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        calls++;
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  await store.indexPending();
  const abort = new AbortController();
  const cancelled = store.search({
    access: owner,
    query: "marmot burrow",
    signal: abort.signal,
    track: true,
    rerankMode: "off",
  });
  await started.promise;
  const survivor = store.search({ access: owner, query: "marmot burrow", rerankMode: "off" });
  abort.abort();
  expect(await cancelled).toEqual([]);
  gate.resolve();
  expect((await survivor).map((hit) => hit.id)).toEqual([String(fact.memoryRef.id)]);
  expect(calls).toBe(1);
  expect(store.getVisible(owner, [fact.memoryRef.id])[0]?.shown_count).toBe(0);
});

it("rejects old-model completions and separates fingerprints including query prefixes", async () => {
  const fact = create("Model switch guidance");
  const inner = hashEmbedder("test/same-model-name");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let oldQueries = 0;
  store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        oldQueries++;
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  await store.indexPending();
  const reasons: string[] = [];
  const old = store.search({
    access: owner,
    query: "marmot burrow",
    rerankMode: "off",
    onFallback: (reason) => reasons.push(reason),
  });
  await started.promise;
  let newQueries = 0;
  store.setEmbedder({
    spec: { ...inner.spec, queryPrefix: "new query interpretation: " },
    async embed(texts, kind) {
      if (kind === "query") newQueries++;
      return inner.embed(texts, kind);
    },
  });
  await store.indexPending();
  gate.resolve();
  expect((await old).map((hit) => hit.id)).toEqual([String(fact.memoryRef.id)]);
  expect(reasons).toContain("model_changed");
  await store.search({ access: owner, query: "marmot burrow", rerankMode: "off" });
  await store.search({ access: owner, query: "marmot burrow", rerankMode: "off" });
  expect(oldQueries).toBe(1);
  expect(newQueries).toBe(1);
});

it("reauthorizes before reranking and drops corrected revisions after asynchronous inference", async () => {
  const changing = create("Changing guidance", { scope: "project", project: dataRepo });
  const moved = create("Moving guidance", { scope: "project", project: dataRepo });
  const survivor = create("Surviving guidance");
  const calls = inference();
  await store.indexPending();
  await store.search({ access: Access.agent(dataRepo.key), query: "marmot burrow", rerankMode: "off" });
  update(moved, { scope: "project", project: otherRepo });
  await store.indexPending();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const seen: string[][] = [];
  store.setReranker({
    model: "test/final-reauth",
    async score(_query, docs) {
      seen.push([...docs]);
      started.resolve();
      await gate.promise;
      return docs.map(() => 0.9);
    },
  });
  const search = store.search({ access: Access.agent(dataRepo.key), query: "marmot burrow" });
  await started.promise;
  update(changing, { title: "Corrected guidance" });
  gate.resolve();
  expect((await search).map((hit) => hit.id)).toEqual([String(survivor.memoryRef.id)]);
  expect(seen[0]?.some((text) => text.includes("Moving guidance"))).toBe(false);
  expect(seen[0]?.some((text) => text.includes("Changing guidance"))).toBe(true);
  expect(calls.queries).toEqual(["marmot burrow"]);
  await store.indexPending();
});

it("returns only current-revision visible evidence and invalidates source-dependent candidate entries", async () => {
  const source = create("Primary guidance");
  const dependent = store.mutations.mutate(ownerMutation(owner), {
    requestId: `retrieval-${++request}`,
    operation: "create",
    change: {
      title: "Derived guidance",
      content: "marmot burrow derived guidance",
      recordKind: "derived_summary",
    },
    evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1`, includeExcerpt: true }],
  });
  expect(store.currentEvidence(owner, dependent.memoryRef).map((evidence) => evidence.sourceRef)).toEqual([
    `memory:${source.memoryRef.id}@1`,
  ]);
  expect(store.currentEvidence(owner, { ...dependent.memoryRef, revision: 999 })).toEqual([]);
  const privateRecord = store.mutations.mutate(ownerMutation(owner), {
    requestId: `retrieval-${++request}`,
    operation: "create",
    change: {
      title: "Private supported fact",
      content: "Scoped evidence",
      scope: "project",
      project: otherRepo,
    },
    evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1`, includeExcerpt: true }],
  });
  expect(store.currentEvidence(owner, privateRecord.memoryRef).map((evidence) => evidence.sourceRef)).toEqual(
    [`memory:${source.memoryRef.id}@1`],
  );
  expect(store.currentEvidence(Access.agent(dataRepo.key), privateRecord.memoryRef)).toEqual([]);
  await store.search({ access: owner, query: "marmot burrow", mode: "lexical" });
  const generation = store.retrievalGeneration;
  store.invalidateSource(owner, `memory:${source.memoryRef.id}@1`);
  expect(store.retrievalGeneration).toBeGreaterThan(generation);
  expect(store.currentEvidence(owner, dependent.memoryRef)).toEqual([]);
  expect(
    (await store.search({ access: owner, query: "marmot burrow", mode: "lexical" })).map((hit) => hit.id),
  ).not.toContain(String(dependent.memoryRef.id));
});

it("counts every eligible pin beyond selection limits without including hidden, invalid or disallowed pins", () => {
  for (let index = 0; index < 12; index++) create(`Pinned global ${index}`, { pinned: true });
  create("Pinned local", { pinned: true, scope: "project", project: dataRepo });
  create("Pinned foreign", { pinned: true, scope: "project", project: otherRepo });
  create("Pinned episode", { pinned: true, recordKind: "episode" });
  create("Pinned expired", { pinned: true, validUntil: "2026-09-30T00:00:00.000Z" });
  create("Pinned future", { pinned: true, validFrom: "2026-10-02T00:00:00.000Z" });
  create("Pinned candidate", { pinned: true, state: "candidate" });
  create("Unpinned fact");
  const access = Access.agent(dataRepo.key);
  expect(store.countPinned(access, ["fact"])).toBe(13);
  expect(store.countPinned(access)).toBe(14);
  expect(store.countPinned(Access.agent(null), ["fact"])).toBe(12);
  expect(store.countPinned(owner, ["fact"])).toBe(14);
  expect(store.countPinned(access, [])).toBe(0);
  expect(store.list({ access, recordKinds: ["fact"], pinned: true, limit: 1 })[0]?.title).toBe(
    "Pinned global 0",
  );
});
