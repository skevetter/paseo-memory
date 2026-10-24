import { afterEach, beforeEach, expect, it, setSystemTime, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { ownerMutation } from "../service/mutations";
import { openDatabase } from "../service/sqlite";
import { type MemoryRef, MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import type { FeedbackInput } from "../shared/resources";
import { fixtureModelIdentity, hashEmbedder, owner, tempDir } from "./helpers";

let service: RunningService;
let dataDir: string;
beforeEach(async () => {
  setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
  dataDir = tempDir("pm-feedback-proof-");
  service = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
});
afterEach(async () => {
  try {
    await service?.stop();
  } finally {
    setSystemTime();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paseo-memory-key": serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
async function mutation(body: unknown) {
  const result = await post("mutate", body);
  expect(result.status).toBe(200);
  return MutationResultSchema.parse(result.body);
}
async function create(label: string, source?: MemoryRef) {
  return mutation({
    requestId: `create-${label}`,
    operation: "create",
    change: { scope: "global", title: label, content: `Independent ${label} observation` },
    evidence: source ? [{ sourceKind: "memory", sourceRef: `memory:${source.id}@${source.revision}` }] : [],
  });
}
async function delivered(ref: MemoryRef): Promise<string> {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(service.secret, {
        projectKey: null,
        agentId: "feedback-reader",
        nonce: "feedback-reader",
        provider: "fixture",
      }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "read-independent-target",
      method: "tools/call",
      params: { name: "memory_get", arguments: { ids: [ref.id] } },
    }),
  });
  expect(response.status).toBe(200);
  const result = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.object({
          retrieval: z.object({
            retrievalId: z.string(),
            memoryRefs: z.array(z.object({ id: z.number(), revision: z.number() })),
          }),
        }),
      }),
    })
    .parse(await response.json()).result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.retrieval.memoryRefs).toEqual([ref]);
  return result.structuredContent.retrieval.retrievalId;
}
function row(ref: MemoryRef) {
  const { db } = openDatabase(join(dataDir, "memory.db"));
  try {
    const found = db
      .query<
        {
          validated_helpful_count: number;
          record_revision: number;
          updated_at: string;
          verified_at: string | null;
        },
        [number]
      >("SELECT validated_helpful_count,record_revision,updated_at,verified_at FROM memories WHERE id=?")
      .get(ref.id);
    if (!found) throw new Error("The independent feedback target was unexpectedly removed.");
    return found;
  } finally {
    db.close();
  }
}
function assessmentValidated(eventId: string) {
  const { db } = openDatabase(join(dataDir, "memory.db"));
  try {
    return db
      .query<{ validated: number }, [string]>("SELECT validated FROM memory_feedback WHERE event_id=?")
      .get(eventId)?.validated;
  } finally {
    db.close();
  }
}

it.each(["update", "archive"] as const)(
  "retracts validator boosts after normal source %s while retaining the historical assessment",
  async (operation) => {
    const source = await create("validation-source");
    const target = await create("independent-target");
    const collector = await create("proof-collector", source.memoryRef);
    setSystemTime(new Date("2026-09-01T08:05:00.000Z"));
    const retrievalId = await delivered(target.memoryRef);
    const original = row(target.memoryRef);
    const feedback: FeedbackInput = {
      eventId: "initial-validation",
      retrievalId,
      memoryRef: target.memoryRef,
      basis: "validator",
      signal: "helpful",
      evidenceRefs: collector.evidenceRefs,
      verifierId: "fixture/independent-validator",
      verifierVersion: "1",
    };
    expect((await post("feedback", feedback)).status).toBe(200);
    expect(row(target.memoryRef)?.validated_helpful_count).toBe(1);
    setSystemTime(new Date("2026-09-01T08:10:00.000Z"));
    const changed = await mutation({
      requestId: "change-validation-source",
      operation,
      id: source.memoryRef.id,
      expectedRevision: source.memoryRef.revision,
      change: operation === "update" ? { content: "Corrected independent observation" } : {},
    });
    expect(row(target.memoryRef)).toEqual(original);
    expect(assessmentValidated(feedback.eventId)).toBe(0);
    for (const eventId of [feedback.eventId, "new-stale-validation"]) {
      const refused = await post("feedback", { ...feedback, eventId });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refused.body).toMatchObject({ error: { code: expect.any(String) } });
    }
    expect(row(target.memoryRef)).toEqual(original);
    expect(assessmentValidated("new-stale-validation")).toBeUndefined();
    const current =
      operation === "archive"
        ? await mutation({
            requestId: "promote-validation-source",
            operation: "promote",
            id: changed.memoryRef.id,
            expectedRevision: changed.memoryRef.revision,
          })
        : changed;
    const fresh = await create("current-proof-collector", current.memoryRef);
    expect(
      (
        await post("feedback", {
          ...feedback,
          eventId: "current-validation",
          evidenceRefs: fresh.evidenceRefs,
        })
      ).status,
    ).toBe(200);
    expect(row(target.memoryRef)).toEqual({ ...original, validated_helpful_count: 1 });
    expect(assessmentValidated("current-validation")).toBe(1);
  },
);

it("expires transitive validation proof exactly at its validity boundary without refreshing the target fact", async () => {
  const source = await mutation({
    requestId: "temporary-source",
    operation: "create",
    change: {
      scope: "global",
      title: "Temporary source",
      content: "An independently observed temporary condition",
      validUntil: "2026-09-01T09:00:00Z",
    },
  });
  const derived = await mutation({
    requestId: "derived-validation-source",
    operation: "create",
    change: {
      scope: "global",
      recordKind: "derived_summary",
      title: "Derived proof",
      content: "A proof supported by the temporary condition",
    },
    evidence: [
      { sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@${source.memoryRef.revision}` },
    ],
  });
  const target = await create("time-independent-target");
  const collector = await create("transitive-proof-collector", derived.memoryRef);
  const retrievalId = await delivered(target.memoryRef);
  const original = row(target.memoryRef);
  const input: FeedbackInput = {
    eventId: "temporary-validation",
    retrievalId,
    memoryRef: target.memoryRef,
    basis: "validator",
    signal: "helpful",
    evidenceRefs: collector.evidenceRefs,
    verifierId: "fixture/expiry-validator",
    verifierVersion: "1",
  };
  expect((await post("feedback", input)).status).toBe(200);
  setSystemTime(new Date("2026-09-01T08:59:59.999Z"));
  const before = await post("status", {});
  expect(before.body).toMatchObject({ resources: { feedback: { validatedHelpful: 1 } } });
  setSystemTime(new Date("2026-09-01T09:00:00.000Z"));
  await delivered(target.memoryRef);
  expect(row(target.memoryRef)).toEqual(original);
  expect(assessmentValidated(input.eventId)).toBe(0);
  const after = await post("status", {});
  expect(after.body).toMatchObject({
    resources: { feedback: { validatedHelpful: 0, validatorReported: 1 } },
  });
  const stale = await post("feedback", { ...input, eventId: "expired-validation" });
  expect(stale.status).toBeGreaterThanOrEqual(400);
  expect(stale.status).toBeLessThan(500);
  expect(assessmentValidated("expired-validation")).toBeUndefined();
});

it("withholds deep-source validation hints before queued propagation while retaining unrelated validation", async () => {
  service.store.configure({ ...service.store.config, usageRanking: true });
  const source = await create("chain-root");
  const first = await create("chain-one", source.memoryRef);
  const second = await create("chain-two", first.memoryRef);
  const proof = await create("chain-collector", second.memoryRef);
  const target = await create("eligible ranking alpha");
  const unrelatedRoot = await create("unrelated-proof-root");
  const unrelatedSource = await mutation({
    requestId: "unrelated-derived-proof",
    operation: "create",
    change: {
      scope: "global",
      recordKind: "derived_summary",
      title: "Unrelated derived proof",
      content: "A separate supported observation.",
    },
    evidence: [
      {
        sourceKind: "memory",
        sourceRef: `memory:${unrelatedRoot.memoryRef.id}@${unrelatedRoot.memoryRef.revision}`,
      },
    ],
  });
  const unrelatedProof = await create("unrelated-collector", unrelatedSource.memoryRef);
  const unrelated = await create("eligible ranking beta");
  const targetRetrieval = await delivered(target.memoryRef);
  const unrelatedRetrieval = await delivered(unrelated.memoryRef);
  const before = await service.store.search({
    query: "eligible ranking",
    mode: "lexical",
    rerankMode: "off",
    access: owner,
  });
  const originalTarget = before.find((hit) => hit.id === String(target.memoryRef.id));
  const originalUnrelated = before.find((hit) => hit.id === String(unrelated.memoryRef.id));
  if (!originalTarget || !originalUnrelated) throw new Error("The independent ranking targets are missing.");
  for (const [record, evidence, retrievalId] of [
    [target, proof, targetRetrieval],
    [unrelated, unrelatedProof, unrelatedRetrieval],
  ] as const) {
    const input: FeedbackInput = {
      eventId: `validated-${record.memoryRef.id}`,
      retrievalId,
      memoryRef: record.memoryRef,
      basis: "validator",
      signal: "helpful",
      evidenceRefs: evidence.evidenceRefs,
      verifierId: "fixture/chain-validator",
      verifierVersion: "1",
    };
    expect((await post("feedback", input)).status).toBe(200);
  }
  service.store.mutations.mutate(ownerMutation(owner), {
    requestId: "correct-chain-root",
    operation: "update",
    id: source.memoryRef.id,
    expectedRevision: source.memoryRef.revision,
    change: { content: "The source correction invalidates the old proof chain" },
  });
  // No await: inspect the bounded-propagation window before its scheduled continuation.
  const current = service.store.getVisible(owner, [target.memoryRef.id, unrelated.memoryRef.id]);
  expect(Object.fromEntries(current.map((entry) => [entry.id, entry.validated_helpful_count]))).toEqual({
    [target.memoryRef.id]: 0,
    [unrelated.memoryRef.id]: 1,
  });
  expect(service.store.resourceStatus().feedback.validatedHelpful).toBe(1);
  const ranked = await service.store.search({
    query: "eligible ranking",
    mode: "lexical",
    rerankMode: "off",
    access: owner,
  });
  expect(ranked.map((hit) => Number(hit.id)).toSorted()).toEqual(
    [target.memoryRef.id, unrelated.memoryRef.id].toSorted(),
  );
  expect(ranked.find((hit) => hit.id === String(target.memoryRef.id))?.score).toBe(originalTarget.score);
  expect(ranked.find((hit) => hit.id === String(unrelated.memoryRef.id))?.score).toBeGreaterThan(
    originalUnrelated.score,
  );
});

async function validatedRankingTarget(label: string, source: MemoryRef) {
  const target = await mutation({
    requestId: `ranking-target-${label}`,
    operation: "create",
    change: {
      scope: "global",
      type: "decision",
      title: `ranking stance ${label}`,
      content: `Independent ranking stance for ${label}.`,
    },
  });
  const proof = await create(`ranking-proof-${label}`, source);
  const retrievalId = await delivered(target.memoryRef);
  const feedback: FeedbackInput = {
    eventId: `ranking-assessment-${label}`,
    retrievalId,
    memoryRef: target.memoryRef,
    basis: "validator",
    signal: "helpful",
    evidenceRefs: proof.evidenceRefs,
    verifierId: "fixture/ranking-validator",
    verifierVersion: "1",
  };
  expect((await post("feedback", feedback)).status).toBe(200);
  return target.memoryRef;
}

it.each(["correction", "expiry"] as const)(
  "recomputes current validation hints before final rerank selection after held proof %s",
  async (change) => {
    service.store.configure({ ...service.store.config, usageRanking: true });
    const source = await mutation({
      requestId: "held-ranking-source",
      operation: "create",
      change: {
        scope: "global",
        title: "Held ranking validation source",
        content: "Original independently observed proof.",
        validUntil: change === "expiry" ? "2026-09-01T09:00:00.000Z" : null,
      },
    });
    const target = await validatedRankingTarget("alpha", source.memoryRef);
    const peerSource = await create("stable-ranking-source");
    const peer = await validatedRankingTarget("beta", peerSource.memoryRef);
    await service.store.indexPending();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    service.store.setReranker({
      model: "fixture/held-validation",
      identity: fixtureModelIdentity("fixture/held-validation", 1, "reranking"),
      async score(_query, documents) {
        started.resolve();
        await release.promise;
        return documents.map(() => 0.5);
      },
    });
    const pending = service.store.search({
      query: "ranking stance",
      type: "decision",
      limit: 1,
      rerankMode: "on",
      access: owner,
    });
    await started.promise;
    try {
      if (change === "correction") {
        service.store.mutations.mutate(ownerMutation(owner), {
          requestId: "correct-held-ranking-proof",
          operation: "update",
          id: source.memoryRef.id,
          expectedRevision: source.memoryRef.revision,
          change: { content: "The old validation support was corrected." },
        });
      } else setSystemTime(new Date("2026-09-01T09:00:00.000Z"));
      release.resolve();
      const hits = await pending;
      expect(hits.map((hit) => hit.id)).toEqual([String(peer.id)]);
      expect(service.store.getVisible(owner, [target.id])[0]?.record_revision).toBe(target.revision);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it("reweights exact-title results when proof expires between candidate and final reads", async () => {
  service.store.configure({ ...service.store.config, usageRanking: true });
  const source = await mutation({
    requestId: "exact-proof-source",
    operation: "create",
    change: {
      scope: "global",
      title: "Exact-title validation proof",
      content: "A time-bounded independent observation.",
      validUntil: "2026-09-01T09:00:00.000Z",
    },
  });
  const target = await validatedRankingTarget("exact", source.memoryRef);
  await service.store.indexPending();
  const original = service.store.feedback.expire.bind(service.store.feedback);
  let reads = 0;
  const boundary = spyOn(service.store.feedback, "expire").mockImplementation(() => {
    reads++;
    if (reads === 2) setSystemTime(new Date("2026-09-01T09:00:00.000Z"));
    return original();
  });
  const input = { query: "ranking stance exact", access: owner, track: false, limit: 1 };
  let during: Awaited<ReturnType<typeof service.store.search>>;
  try {
    during = await service.store.search(input);
  } finally {
    boundary.mockRestore();
  }
  expect(row(target).validated_helpful_count).toBe(0);
  expect(during.map((hit) => hit.id)).toEqual([String(target.id)]);
  const after = await service.store.search(input);
  expect(during.map((hit) => hit.score)).toEqual(after.map((hit) => hit.score));
});
