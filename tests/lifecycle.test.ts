import { afterEach, beforeEach, expect, it } from "bun:test";
import { join } from "node:path";
import { Access } from "../service/access";
import { buildContext } from "../service/context";
import { MutationError, mutationRequestId, ownerMutation } from "../service/mutations";
import { openDatabase } from "../service/sqlite";
import { MemoryStore } from "../service/store";
import type { MutationRequest, MutationResult } from "../shared/lifecycle";
import { dataRepo, otherRepo, owner, tempDir } from "./helpers";

let store: MemoryStore;
let at: Date;
beforeEach(() => {
  at = new Date("2026-10-01T00:00:00.000Z");
  store = new MemoryStore({ path: join(tempDir("pm-lifecycle-"), "memory.db"), now: () => at });
});
afterEach(() => store.close());

function mutate(input: MutationRequest): MutationResult {
  return store.mutations.mutate(ownerMutation(owner), input);
}
function create(title: string, change: MutationRequest["change"] = {}): MutationResult {
  return mutate({
    requestId: mutationRequestId(),
    operation: "create",
    change: { title, content: `${title} bounded claim`, scope: "global", ...change },
  });
}
function change(
  ref: MutationResult,
  patch: MutationRequest["change"],
  operation: "update" | "promote" | "restore" | "archive" = "update",
): MutationResult {
  return mutate({
    requestId: mutationRequestId(),
    operation,
    id: ref.memoryRef.id,
    expectedRevision: ref.memoryRef.revision,
    change: patch,
  });
}

it("expires a temporary exception without a read refreshing factual validity", async () => {
  const temporary = create("Temporary deploy exception", {
    validFrom: at.toISOString(),
    validUntil: "2026-10-02T00:00:00.000Z",
  });
  store.markShown([temporary.memoryRef.id]);
  expect(store.getVisible(owner, [temporary.memoryRef.id]).map((r) => r.title)).toEqual([
    "Temporary deploy exception",
  ]);
  at = new Date("2026-10-02T00:00:00.000Z");
  expect(store.getVisible(owner, [temporary.memoryRef.id])).toEqual([]);
  expect(await store.search({ access: owner, query: "deploy exception" })).toEqual([]);
  expect(buildContext({ store, project: null }).memoryIds).not.toContain(temporary.memoryRef.id);
  expect(store.lifecycleDetail(owner, temporary.memoryRef.id)?.verifiedAt).toBeNull();
  expect(store.historical(owner, temporary.memoryRef.id, "2026-10-01T12:00:00.000Z")?.title).toBe(
    "Temporary deploy exception",
  );
});

it("keeps full immutable metadata revisions and restores into revalidation rather than silently promoting", () => {
  const initial = create("Original", { pinned: true, validUntil: "2026-11-01T00:00:00.000Z" });
  at = new Date("2026-10-02T00:00:00.000Z");
  const revised = change(initial, {
    title: "Corrected",
    content: "New evidence changes the claim",
    pinned: false,
  });
  const restored = change(revised, { sourceRevision: initial.memoryRef.revision }, "restore");
  expect(restored.state).toBe("candidate");
  expect(store.getVisible(owner, [initial.memoryRef.id])).toEqual([]);
  const detail = store.lifecycleDetail(owner, initial.memoryRef.id);
  expect(detail?.revisions.map((r) => r.snapshot.title)).toEqual(["Original", "Corrected", "Original"]);
  expect(detail?.revisions[0]?.snapshot).toMatchObject({
    pinned: 1,
    valid_until: "2026-11-01T00:00:00.000Z",
  });
  expect(detail?.revisions.every((r) => !r.legacyMetadataUnknown)).toBe(true);
  const promoted = change(restored, {}, "promote");
  expect(promoted.state).toBe("active");
});

it("does not reset verification for curation-only or undefined optional fields", () => {
  const asserted = create("Owner approved convention");
  const archived = change(asserted, {}, "archive");
  const active = change(archived, {}, "promote");
  at = new Date("2026-10-03T00:00:00.000Z");
  const pinned = change(active, { pinned: true, title: undefined, content: undefined });
  expect(store.lifecycleDetail(owner, pinned.memoryRef.id)).toMatchObject({
    verificationStatus: "verified",
    verifiedAt: "2026-10-01T00:00:00.000Z",
  });
  const same = change(pinned, { pinned: true });
  expect(same.status).toBe("unchanged");
  expect(same.memoryRef.revision).toBe(pinned.memoryRef.revision);
});

it("checks current and historical scope before returning old content or a conflict diff", () => {
  const privateMemory = create("Other project secret", { scope: "project", project: otherRepo });
  const moved = change(privateMemory, {
    scope: "project",
    project: dataRepo,
    content: "Public to this project now",
  });
  const access = Access.agent(dataRepo.key);
  expect(store.historical(access, privateMemory.memoryRef.id, at.toISOString())?.content).toBe(
    "Public to this project now",
  );
  const history = store.lifecycleDetail(access, privateMemory.memoryRef.id);
  expect(history?.revisions.map((r) => r.snapshot.content)).toEqual(["Public to this project now"]);
  expect(store.detailAuthorized(access, privateMemory.memoryRef.id).versions).toEqual([]);
  try {
    store.mutations.mutate(
      { id: "agent-a", actorId: "agent-a", access },
      {
        requestId: "stale",
        operation: "update",
        id: moved.memoryRef.id,
        expectedRevision: 1,
        change: { content: "Try stale overwrite" },
      },
    );
    throw new Error("Expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(MutationError);
    expect(JSON.stringify((error as MutationError).details)).not.toContain(
      "Other project secret bounded claim",
    );
  }
});

it("invalidates dependent facts and cancels exact queued evidence jobs on correction", () => {
  const source = create("Primary source");
  const derived = mutate({
    requestId: "summary",
    operation: "create",
    change: { title: "Summary", content: "Summary of primary source", recordKind: "derived_summary" },
    evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1`, includeExcerpt: true }],
  });
  const db = openDatabase(store.path).db;
  try {
    db.query(
      "INSERT INTO review_jobs(id,source_watermark,purpose,policy_revision,state,created_at,updated_at) VALUES ('job','1','consolidation',1,'queued',?,?)",
    ).run(at.toISOString(), at.toISOString());
    db.query("INSERT INTO review_job_sources(job_id,memory_id,revision) VALUES ('job',?,1)").run(
      source.memoryRef.id,
    );
    change(source, { content: "Corrected primary source" });
    expect(store.lifecycleDetail(owner, derived.memoryRef.id)?.state).toBe("needs_recheck");
    expect(store.getVisible(owner, [derived.memoryRef.id])).toEqual([]);
    expect(db.query<{ state: string }, []>("SELECT state FROM review_jobs WHERE id='job'").get()?.state).toBe(
      "cancelled",
    );
  } finally {
    db.close();
  }
});

it("bounds propagation and suppresses deep dependencies while queued work survives restart", () => {
  const source = create("Chain root");
  let previous = source;
  for (let i = 0; i < 140; i++) {
    previous = mutate({
      requestId: `chain-${i}`,
      operation: "create",
      change: { title: `Derived ${i}`, content: `Derived node ${i}`, recordKind: "derived_summary" },
      evidence: [
        { sourceKind: "memory", sourceRef: `memory:${previous.memoryRef.id}@1`, includeExcerpt: false },
      ],
    });
  }
  change(source, { content: "Root corrected" });
  expect(store.getVisible(owner, [previous.memoryRef.id])).toEqual([]);
  const path = store.path;
  store.close();
  store = new MemoryStore({ path, now: () => at });
  expect(store.getVisible(owner, [previous.memoryRef.id])).toEqual([]);
});

it("forgets source/dependent text, versions, excerpts and indexes and blocks replay resurrection", async () => {
  const source = create("Secret to forget");
  const summary = mutate({
    requestId: "forgotten-summary",
    operation: "create",
    change: { title: "Derived secret", content: "Secret derived text", recordKind: "derived_summary" },
    evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1`, includeExcerpt: true }],
  });
  const preview = store.lifecycle.preview(owner, source.memoryRef.id);
  expect(preview.records.map((r) => r.id).sort()).toEqual([source.memoryRef.id, summary.memoryRef.id].sort());
  const forgotten = mutate({
    requestId: "forget",
    operation: "forget",
    id: source.memoryRef.id,
    expectedRevision: 1,
  });
  expect(
    mutate({ requestId: "forget", operation: "forget", id: source.memoryRef.id, expectedRevision: 1 }),
  ).toEqual(forgotten);
  expect(await store.search({ query: "secret", access: owner })).toEqual([]);
  expect(store.lifecycleDetail(owner, source.memoryRef.id)).toBeNull();
  const db = openDatabase(store.path).db;
  try {
    for (const table of [
      "memory_revisions",
      "memory_versions",
      "memory_evidence",
      "memory_evidence_links",
      "memory_relations",
      "memory_embeddings",
    ])
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(
      db.query("SELECT identifier FROM memory_tombstones WHERE kind='memory' ORDER BY identifier").all(),
    ).toEqual([{ identifier: String(source.memoryRef.id) }, { identifier: String(summary.memoryRef.id) }]);
  } finally {
    db.close();
  }
  expect(() =>
    mutate({
      requestId: "late",
      operation: "create",
      change: { title: "Replay", content: "Secret derived text" },
      evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1` }],
    }),
  ).toThrow("forgotten source");
  expect(create("New identity").memoryRef.id).toBeGreaterThan(summary.memoryRef.id);
});

it("source forget replays its receipt and rejects request-ID reuse for a different source", () => {
  store.provenance.registerArtifact(owner, {
    sourceRef: "artifact:forget",
    content: "Forget this artifact",
    scope: "global",
    projectKey: null,
    allowExcerpt: true,
  });
  mutate({
    requestId: "artifact-fact",
    operation: "create",
    change: { title: "Artifact claim", content: "Supported artifact claim" },
    evidence: [{ sourceKind: "artifact", sourceRef: "artifact:forget", includeExcerpt: true }],
  });
  const first = store.forgetSource(owner, "artifact:forget", "source-request");
  expect(first).toEqual({ forgotten: 1 });
  expect(store.forgetSource(owner, "artifact:forget", "source-request")).toEqual(first);
  expect(() => store.forgetSource(owner, "artifact:different", "source-request")).toThrow(MutationError);
});

it("authorizes project-only updates and all supplied project metadata before writing", () => {
  const original = create("A scoped claim", { scope: "project", project: dataRepo });
  const principal = { id: "project-a", actorId: "project-a", access: Access.agent(dataRepo.key) };
  expect(() =>
    store.mutations.mutate(principal, {
      requestId: "project-only",
      operation: "update",
      id: original.memoryRef.id,
      expectedRevision: 1,
      change: { project: otherRepo },
    }),
  ).toThrow(MutationError);
  expect(store.getVisible(owner, [original.memoryRef.id])[0]?.project_key).toBe(dataRepo.key);
  expect(store.projectByKey(otherRepo.key)).toBeNull();
  const global = create("Global claim");
  expect(() =>
    store.mutations.mutate(principal, {
      requestId: "foreign-metadata",
      operation: "update",
      id: global.memoryRef.id,
      expectedRevision: 1,
      change: { project: otherRepo },
    }),
  ).toThrow(MutationError);
  const allowed = store.mutations.mutate(principal, {
    requestId: "own-metadata",
    operation: "update",
    id: global.memoryRef.id,
    expectedRevision: 1,
    change: { project: dataRepo, pinned: true },
  });
  expect(store.getVisible(owner, [allowed.memoryRef.id])[0]).toMatchObject({
    scope: "global",
    project_key: null,
  });
  expect(store.projectByKey(otherRepo.key)).toBeNull();
});

it("hides dependent summaries at source expiry and refuses expired-source promotion", async () => {
  const source = create("Expiring support", { validUntil: "2026-10-02T00:00:00Z" });
  const evidence = [
    { sourceKind: "memory" as const, sourceRef: `memory:${source.memoryRef.id}@1`, includeExcerpt: false },
  ];
  const summary = mutate({
    requestId: "expiring-summary",
    operation: "create",
    evidence,
    change: {
      title: "Temporary derived fact",
      content: "Derived from expiring support",
      recordKind: "derived_summary",
    },
  });
  expect(summary.state).toBe("active");
  expect(store.getVisible(owner, [summary.memoryRef.id]).map((row) => row.id)).toEqual([
    summary.memoryRef.id,
  ]);
  at = new Date("2026-10-02T00:00:00.000Z");
  expect(store.getVisible(owner, [summary.memoryRef.id])).toEqual([]);
  expect(await store.search({ access: owner, query: "Temporary derived fact" })).toEqual([]);
  const stale = mutate({
    requestId: "already-expired",
    operation: "create",
    evidence,
    change: {
      title: "Unsupported derived fact",
      content: "Expired support cannot verify this",
      recordKind: "derived_summary",
    },
  });
  expect(stale).toMatchObject({ state: "candidate", evidenceValidation: "unresolved" });
  expect(() =>
    mutate({
      requestId: "promote-expired",
      operation: "promote",
      id: stale.memoryRef.id,
      expectedRevision: stale.memoryRef.revision,
      evidenceRefs: stale.evidenceRefs,
    }),
  ).toThrow(MutationError);
});

it("compares equivalent ISO instants at start, expiry and historical boundaries", () => {
  const fact = create("Boundary fact", {
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2026-10-02T00:00:00Z",
  });
  expect(store.getVisible(owner, [fact.memoryRef.id]).map((row) => row.id)).toEqual([fact.memoryRef.id]);
  expect(store.historical(owner, fact.memoryRef.id, "2026-10-01T00:00:00Z")?.id).toBe(fact.memoryRef.id);
  expect(() =>
    create("Empty interval", { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2026-10-01T00:00:00Z" }),
  ).toThrow(MutationError);
  at = new Date("2026-10-02T00:00:00.000Z");
  expect(store.getVisible(owner, [fact.memoryRef.id])).toEqual([]);
});

it("revalidates a corrected summary with only fresh supporting revisions", async () => {
  const source = create("Current deployment color", { content: "Deployment color is green" });
  const summary = mutate({
    requestId: "green-summary",
    operation: "create",
    change: {
      title: "Deployment digest",
      content: "Deployment color is green",
      recordKind: "derived_summary",
    },
    evidence: [{ sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@1` }],
  });
  const corrected = change(source, { content: "Deployment color is red" });
  const invalidated = store.lifecycleDetail(owner, summary.memoryRef.id);
  expect(invalidated?.state).toBe("needs_recheck");
  const freshSource = `memory:${source.memoryRef.id}@${corrected.memoryRef.revision}`;
  const revised = mutate({
    requestId: "red-summary",
    operation: "update",
    id: summary.memoryRef.id,
    expectedRevision: invalidated?.memoryRef.revision,
    change: { content: "Deployment color is red" },
    evidence: [{ sourceKind: "memory", sourceRef: freshSource }],
  });
  const promoted = mutate({
    requestId: "validate-red-summary",
    operation: "promote",
    id: summary.memoryRef.id,
    expectedRevision: revised.memoryRef.revision,
    evidenceRefs: revised.evidenceRefs,
  });
  expect(promoted.state).toBe("active");
  expect(store.lifecycleDetail(owner, summary.memoryRef.id)?.evidence.map((e) => e.sourceRef)).toEqual([
    freshSource,
  ]);
  expect(store.getVisible(owner, [summary.memoryRef.id])[0]?.content).toBe("Deployment color is red");
  expect((await store.search({ access: owner, query: "Deployment digest" })).map((hit) => hit.id)).toContain(
    String(summary.memoryRef.id),
  );
  expect(buildContext({ store, project: null }).memoryIds).toContain(summary.memoryRef.id);
  expect(store.provenance.getVisible(owner, summary.evidenceRefs).map((e) => e.sourceRef)).toEqual([
    `memory:${source.memoryRef.id}@1`,
  ]);
});

it("prevents a forgotten producer from recreating content through the mutation domain", () => {
  const principal = {
    id: "nonce:forgotten-producer",
    actorId: "nonce:forgotten-producer",
    access: Access.agent(null),
  };
  const input = {
    requestId: "producer-save",
    operation: "create",
    change: { title: "Sensitive assertion", content: "Must not be recreated", scope: "global" },
  } as const;
  const saved = store.mutations.mutate(principal, input);
  mutate({
    requestId: "forget-producer-record",
    operation: "forget",
    id: saved.memoryRef.id,
    expectedRevision: saved.memoryRef.revision,
  });
  expect(() =>
    store.mutations.mutate(principal, { ...input, requestId: "different-recreation-request" }),
  ).toThrow(MutationError);
});
