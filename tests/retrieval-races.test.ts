import { afterEach, beforeEach, expect, it } from "bun:test";
import { retrieveContext } from "../service/context";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { MemoryStore } from "../service/store";
import type { MutationRequest } from "../shared/lifecycle";
import { DEFAULT_RETRIEVAL_POLICY } from "../shared/retrieval";
import { DEFAULT_RUNTIME } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, owner } from "./helpers";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
  store.configure({
    ...DEFAULT_RUNTIME,
    detailLevel: "summaries",
    retrievalPolicy: {
      ...structuredClone(DEFAULT_RETRIEVAL_POLICY),
      reservedTokens: 0,
      reservedChars: 0,
      reservedBytes: 0,
    },
  });
});
afterEach(() => store.close());
function seed(title: string, change: MutationRequest["change"] = {}) {
  return store.mutations.mutate(
    { ...ownerMutation(owner), agentId: "source-agent" },
    {
      requestId: mutationRequestId(),
      operation: "create",
      change: { title, content: "Migration rollout source detail", scope: "global", ...change },
    },
  );
}
function capture(project = dataRepo, text = "Private captured source claim") {
  store.recordTurn({
    agentId: "source-agent",
    project,
    provider: null,
    title: "Captured source",
    workspaceDir: null,
    userText: "Synthetic task",
    assistantText: text,
    files: [],
  });
}
function forget(ref: { id: number; revision: number }) {
  return store.mutations.mutate(ownerMutation(owner), {
    requestId: mutationRequestId(),
    operation: "forget",
    id: ref.id,
    expectedRevision: ref.revision,
  });
}

it("does not disclose a forgotten session snapshot to a previously unexposed caller", async () => {
  const root = seed("Private source");
  capture();
  store.audit.open({ nonce: "new-reader", projectKey: dataRepo.key, provider: null, tools: true });
  const pending = retrieveContext({
    store,
    project: dataRepo,
    request: { recordKinds: ["episode"], detail: "compact" },
    complete: (result) =>
      store.audit.record("new-reader", {
        kind: "context",
        memories: result.memoryRefs.map((ref) => ref.id),
        sessions: result.sessionIds,
        chars: result.usage.chars,
        budget: 6000,
      }),
  });
  forget(root.memoryRef);
  const result = await pending;
  expect(result.contextText).not.toContain("Private captured source claim");
  expect(result.sessionIds).toEqual([]);
  expect(store.lifecycle.contextInvalidated({ nonce: "new-reader" })).toBe(false);
  expect(store.audit.eventsSince("new-reader", "2000-01-01T00:00:00.000Z")).toEqual([
    expect.objectContaining({ sessions: [], memories: [] }),
  ]);
});
it("drops session copies that moved outside the namespace before finalization", async () => {
  capture();
  const pending = retrieveContext({
    store,
    project: dataRepo,
    request: { recordKinds: ["episode"], detail: "compact" },
  });
  capture(otherRepo, "New foreign captured claim");
  const result = await pending;
  expect(result.sessionIds).toEqual([]);
  expect(result.contextText).not.toContain("Private captured source claim");
  expect(result.contextText).not.toContain("New foreign captured claim");
});
it("applies owner policy narrowing before reranking and final disclosure", async () => {
  seed("First policy fact");
  seed("Second policy fact");
  const inner = hashEmbedder("test/policy-race");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let reranked = 0;
  store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  store.setReranker({
    model: "test/policy-rerank",
    async score(_query, documents) {
      reranked += documents.length;
      return documents.map(() => 1);
    },
  });
  await store.indexPending();
  const pending = retrieveContext({
    store,
    project: null,
    mode: "search",
    request: { query: "migration rollout", detail: "compact" },
  });
  await started.promise;
  const policy = structuredClone(store.config.retrievalPolicy);
  Object.assign(policy.profiles.standard, {
    maxChars: 0,
    maxItems: 0,
    allowedRecordKinds: [],
    detail: "references",
  });
  store.configure({ ...store.config, retrievalPolicy: policy });
  const revision = store.retrievalPolicies.revision;
  gate.resolve();
  const result = await pending;
  expect(result.contextText).toBe("");
  expect(result.memoryRefs).toEqual([]);
  expect(result.policyRevision).toBe(revision);
  expect(result.fallbackReason).toBe("policy_changed");
  expect(reranked).toBe(0);
});
it("reserves unpinned owner preferences before task candidate and item spending", async () => {
  const preference = seed("Owner safety preference", {
    type: "preference",
    recordKind: "preference",
    content: "Never execute without owner approval",
  });
  for (let i = 0; i < 8; i++) seed(`Task fact ${i}`);
  const policy = structuredClone(store.config.retrievalPolicy);
  Object.assign(policy.profiles.standard, { maxCandidates: 2, maxItems: 1, rerankMode: "off" });
  store.configure({ ...store.config, maxPinned: 0, retrievalPolicy: policy });
  const result = await retrieveContext({
    store,
    project: null,
    request: { query: "migration rollout", detail: "compact" },
  });
  expect(result.memoryRefs).toEqual([preference.memoryRef]);
  expect(result.contextText).toContain("Never execute without owner approval");
});
it.each(["correction", "scope", "type"])(
  "does not attach obsolete search scoring after a final-boundary %s",
  async (change) => {
    const root = seed("Exact query target");
    const pending = retrieveContext({
      store,
      project: dataRepo,
      mode: "search",
      scope: "global",
      type: "note",
      request: { query: "Exact query target", detail: "compact" },
    });
    const patch =
      change === "correction"
        ? { content: "Unrelated corrected claim" }
        : change === "scope"
          ? { scope: "project" as const, project: dataRepo }
          : { type: "decision" };
    store.mutations.mutate(ownerMutation(owner), {
      requestId: mutationRequestId(),
      operation: "update",
      id: root.memoryRef.id,
      expectedRevision: 1,
      change: patch,
    });
    const result = await pending;
    expect(result.memoryRefs).toEqual([]);
    expect(result.contextText).not.toContain("Unrelated corrected claim");
  },
);
it.each(["embedder", "reranker"])(
  "fences obsolete scoring when the %s changes during reranking",
  async (changed) => {
    seed("First inference fact");
    seed("Second inference fact");
    const inner = hashEmbedder("test/old-model");
    store.setEmbedder(inner);
    await store.indexPending();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    store.setReranker({
      model: "test/old-reranker",
      async score(_query, documents) {
        started.resolve();
        await gate.promise;
        return documents.map(() => 1);
      },
    });
    const reasons: string[] = [];
    const pending = store.search({
      access: owner,
      query: "migration rollout",
      onFallback: (reason) => reasons.push(reason),
    });
    await started.promise;
    if (changed === "embedder") store.setEmbedder(hashEmbedder("test/new-model"));
    else store.setReranker(null);
    gate.resolve();
    expect(await pending).toEqual([]);
    expect(reasons).toContain("inference_changed");
  },
);
it("does not retain or repopulate a pre-forget query embedding after late completion", async () => {
  const root = seed("Private query source");
  const inner = hashEmbedder("test/privacy-cache");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let queries = 0;
  store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        queries++;
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  await store.indexPending();
  const pending = store.search({ access: owner, query: "private phrase in query", rerankMode: "off" });
  await started.promise;
  forget(root.memoryRef);
  gate.resolve();
  await pending;
  await store.search({ access: owner, query: "private phrase in query", rerankMode: "off" });
  expect(queries).toBe(2);
});

it("revokes cached candidate scoring when the model switches across candidate resolution", async () => {
  seed("First cached fact");
  seed("Second cached fact");
  store.setEmbedder(hashEmbedder("test/cached-model-a"));
  await store.indexPending();
  const reasons: string[] = [];
  const search = () =>
    store.search({
      access: owner,
      query: "migration rollout",
      rerankMode: "off",
      onFallback: (reason) => reasons.push(reason),
    });
  expect((await search()).map((hit) => hit.title)).toEqual(
    expect.arrayContaining(["First cached fact", "Second cached fact"]),
  );
  const pending = search();
  store.setEmbedder(hashEmbedder("test/cached-model-b"));
  expect(await pending).toEqual([]);
  expect(reasons).toContain("inference_changed");
});

it.each(["id", "title", "empty"])("rejects stale policy revisions on the %s fast path", async (kind) => {
  const root = seed("Exact policy target");
  const revision = store.retrievalPolicies.revision;
  store.configure({ ...store.config, extraInstructions: "Changed owner policy" });
  const query = kind === "id" ? `#${root.memoryRef.id}` : kind === "title" ? "Exact policy target" : "";
  const reasons: string[] = [];
  expect(
    await store.search({
      access: owner,
      query,
      policyRevision: revision,
      onFallback: (reason) => reasons.push(reason),
    }),
  ).toEqual([]);
  expect(reasons).toEqual(["policy_changed"]);
});
