import { afterEach, beforeEach, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { LifecycleDetailSchema, type MemoryRef, MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import {
  type FeedbackInput,
  FeedbackResultSchema,
  type ModelUsageInput,
  ResourceStatusSchema,
} from "../shared/resources";
import { RetrievalResultSchema } from "../shared/retrieval";
import { type ProjectRef, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, owner, tempDir } from "./helpers";

const createdAt = "2026-08-01T00:00:00.000Z";
const retrievedAt = "2026-09-01T00:00:00.000Z";
const assessedAt = "2026-10-01T00:00:00.000Z";
const encoder = new Tokenizer(
  {
    version: "1.0",
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: "WhitespaceSplit" },
    post_processor: null,
    decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, release: 1, policy: 2 }, unk_token: "[UNK]" },
  },
  { unk_token: "[UNK]" },
);
const tokenizer = {
  id: "fixture/resource-wordlevel",
  count: (text: string) => encoder.encode(text, { add_special_tokens: false }).ids.length,
};

let service: RunningService | undefined;
let dataDir: string;

function live(): RunningService {
  if (!service) throw new Error("Resource API service was not started");
  return service;
}

async function launch(): Promise<RunningService> {
  const running = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    contextTokenizers: new Map([["resource-provider", tokenizer]]),
    log: silentLogger,
  });
  await running.modelsReady();
  running.store.upsertProject(dataRepo);
  running.store.upsertProject(otherRepo);
  return running;
}

beforeEach(async () => {
  setSystemTime(new Date(createdAt));
  dataDir = tempDir("pm-resource-api-");
  service = await launch();
});
afterEach(async () => {
  try {
    await service?.stop();
  } finally {
    service = undefined;
    setSystemTime();
  }
});

async function restart(): Promise<void> {
  const running = live();
  service = undefined;
  await running.stop();
  service = await launch();
}

async function internal(route: string, body: unknown) {
  const running = live();
  const response = await fetch(`http://127.0.0.1:${running.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(running.secret) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const UsageReceiptSchema = z.object({ recorded: z.boolean(), duplicate: z.boolean() });
const StatusSchema = z.object({ resources: ResourceStatusSchema });
const McpResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z
      .object({ retrieval: RetrievalResultSchema.omit({ contextText: true }) })
      .passthrough(),
  }),
});

async function resources() {
  const response = await internal("status", {});
  expect(response.status).toBe(200);
  return StatusSchema.parse(response.body).resources;
}

async function recordUsage(input: ModelUsageInput) {
  const response = await internal("usage-record", input);
  expect(response.status).toBe(200);
  return UsageReceiptSchema.parse(response.body);
}

async function recordFeedback(input: FeedbackInput) {
  const response = await internal("feedback", input);
  expect(response.status).toBe(200);
  return FeedbackResultSchema.parse(response.body);
}

async function get(ids: number[], provider = "resource-provider") {
  const running = live();
  const response = await fetch(running.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(running.secret, {
        projectKey: dataRepo.key,
        agentId: `resource-reader-${provider}`,
        provider,
        nonce: `resource-reader-${provider}`,
      }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name: "memory_get", arguments: { ids } },
    }),
  });
  expect(response.status).toBe(200);
  const result = McpResultSchema.parse(await response.json()).result;
  expect(result.isError).not.toBe(true);
  return RetrievalResultSchema.parse({
    ...result.structuredContent.retrieval,
    contextText: result.content.map((part) => part.text).join("\n"),
  });
}

async function verifiedRecord(label: string, project: ProjectRef = dataRepo) {
  const artifact = await internal("evidence-artifact", {
    sourceRef: `artifact:resource-${label}`,
    content: `${label} independently observed release policy evidence`,
    scope: "project",
    projectKey: project.key,
    allowExcerpt: true,
    sourceEventAt: createdAt,
  });
  expect(artifact.status).toBe(200);
  const source = z.object({ sourceRef: z.string(), sourceHash: z.string() }).parse(artifact.body);
  const created = await internal("mutate", {
    requestId: `create-${label}`,
    operation: "create",
    evidence: [{ sourceKind: "artifact", ...source }],
    change: {
      title: `${label} release policy`,
      content: `${label} release policy requires independent rollout verification`,
      scope: "project",
      project,
    },
  });
  expect(created.status).toBe(200);
  const memory = MutationResultSchema.parse(created.body);
  expect(memory.evidenceValidation).toBe("resolved");
  return { ...memory, sourceRef: source.sourceRef };
}

async function deliveredRecord() {
  const memory = await verifiedRecord("delivered");
  setSystemTime(new Date(retrievedAt));
  const delivery = await get([memory.memoryRef.id]);
  expect(delivery.memoryRefs).toEqual([memory.memoryRef]);
  return { memory, delivery };
}

async function lifecycle(ref: MemoryRef) {
  const response = await internal("lifecycle-detail", { id: ref.id });
  expect(response.status).toBe(200);
  return LifecycleDetailSchema.parse(response.body);
}

function visible(ref: MemoryRef) {
  const row = live().store.getVisible(owner, [ref.id])[0];
  if (!row) throw new Error(`Memory ${ref.id} is not visible to the owner`);
  return row;
}

function expectRefused(response: { status: number; body: unknown }): void {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(response.body).toMatchObject({ error: { code: expect.any(String) } });
}

async function releaseRanking() {
  const hits = await live().store.search({
    query: "release policy",
    access: owner,
    mode: "lexical",
    track: false,
    includeSessions: false,
  });
  return hits.map((hit) => ({ id: hit.id, score: hit.score }));
}

it("reserves resource writes for authenticated host code and rejects client-selected producers", async () => {
  const input: ModelUsageInput = {
    eventId: "host-event",
    attemptId: "host-attempt",
    sourceSequence: 0,
    stage: "review",
    status: "completed",
    provenance: "unavailable",
  };
  const running = live();
  const endpoint = `http://127.0.0.1:${running.port}/v1`;
  const unsigned = await fetch(`${endpoint}/usage-record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(unsigned.status).toBe(401);
  const headers = {
    "Content-Type": "application/json",
    ...signCaller(running.secret, {
      projectKey: dataRepo.key,
      agentId: "untrusted-resource-agent",
      provider: "resource-provider",
      nonce: "untrusted-resource-agent",
    }),
  };
  const signed = await fetch(`${endpoint}/usage-record`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  expect(signed.status).toBe(401);
  const feedback = await fetch(`${endpoint}/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventId: "forged-feedback",
      retrievalId: "unissued",
      memoryRef: { id: 1, revision: 1 },
      basis: "human",
      signal: "applied",
    }),
  });
  expect(feedback.status).toBe(401);
  expect((await internal("usage-record", { ...input, producerId: "provider-authority" })).status).toBe(400);
  expect((await resources()).usage.maintenance.attempts).toBe(0);
  expect(await recordUsage(input)).toEqual({ recorded: true, duplicate: false });
  expect((await resources()).usage.maintenance).toMatchObject({ attempts: 1, completed: 1 });
});

it("rejects invented provider observations and monetary values without reserving their event", async () => {
  const input: ModelUsageInput = {
    eventId: "usage-claim",
    attemptId: "claim-attempt",
    sourceSequence: 0,
    stage: "review",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "claim-source",
    inputTokens: 7,
  };
  const missingSequence: Record<string, unknown> = { ...input };
  delete missingSequence.sourceSequence;
  const invalid = [
    { ...input, sourceEventId: null },
    missingSequence,
    { ...input, sourceSequence: -1 },
    { ...input, sourceSequence: 0.5 },
    { ...input, sourceSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, sourceSequence: null },
    { ...input, provenance: "unavailable", inputTokens: 0 },
    { ...input, provenance: "estimate", estimator: null },
    { ...input, costAmount: 0.25, currency: null },
    {
      ...input,
      provenance: "local_exact",
      stage: "memory_input",
      estimator: tokenizer.id,
      costAmount: 0,
      currency: "USD",
    },
  ];
  for (const claim of invalid) expect((await internal("usage-record", claim)).status).toBe(400);
  expect((await resources()).usage.maintenance.attempts).toBe(0);
  expect(await recordUsage(input)).toEqual({ recorded: true, duplicate: false });
  expect((await resources()).usage.stages.review).toMatchObject({
    attempts: 1,
    inputTokens: { providerObserved: 7, localExact: null, estimated: null },
    observedCosts: [],
    unavailableBillingAttempts: 1,
  });
});

it("records prepared exact and estimated Memory fragments without claiming provider billing or attachment", async () => {
  const memory = await verifiedRecord("fragment");
  const exact = await get([memory.memoryRef.id]);
  const estimated = await get([memory.memoryRef.id], "unknown-resource-provider");
  expect(exact.memoryRefs).toEqual([memory.memoryRef]);
  expect(estimated.memoryRefs).toEqual([memory.memoryRef]);
  const usage = (await resources()).usage;
  expect(usage.memoryInput).toMatchObject({
    attempts: 2,
    prepared: 2,
    attached: 0,
    discarded: 0,
    providerObservedAttempts: 0,
    localExactAttempts: 1,
    estimatedAttempts: 1,
    inputTokens: {
      providerObserved: null,
      localExact: tokenizer.count(exact.contextText),
      estimated: Buffer.byteLength(estimated.contextText, "utf8"),
    },
    outputTokens: { providerObserved: null, localExact: null, estimated: null },
    observedCosts: [],
    estimatedCosts: [],
    unavailableBillingAttempts: 2,
  });
  expect(usage.providerTurns.attempts).toBe(0);
  expect(usage.maintenance.attempts).toBe(0);
});

it("deduplicates concurrent usage retries and provider source events across restart", async () => {
  const input: ModelUsageInput = {
    eventId: "provider-event",
    attemptId: "provider-attempt",
    sourceSequence: 0,
    stage: "review",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "provider-source-event",
    inputTokens: 100,
    costAmount: 0.125,
    currency: "USD",
  };
  const receipts = await Promise.all([recordUsage(input), recordUsage(input)]);
  expect(receipts.map((receipt) => receipt.duplicate).sort()).toEqual([false, true]);
  expect(receipts.map((receipt) => receipt.recorded)).toEqual([true, true]);
  const changed = await internal("usage-record", { ...input, inputTokens: 200 });
  expect(changed.status).toBe(409);
  expect(changed.body).toMatchObject({ error: { code: "request_conflict" } });
  const renamed = { ...input, eventId: "renamed-provider-event", attemptId: "renamed-attempt" };
  expect((await internal("usage-record", renamed)).status).toBe(409);
  const before = (await resources()).usage;
  expect(before.stages.review).toMatchObject({
    attempts: 1,
    inputTokens: { providerObserved: 100 },
    observedCosts: [{ currency: "USD", amount: 0.125, observations: 1 }],
  });
  await restart();
  expect((await resources()).usage).toEqual(before);
  expect(await recordUsage(input)).toEqual({ recorded: true, duplicate: true });
  expect((await internal("usage-record", renamed)).status).toBe(409);
  expect((await resources()).usage).toEqual(before);
});

it("scopes event and provider-source deduplication to each trusted producer", async () => {
  const input: ModelUsageInput = {
    eventId: "same-event",
    attemptId: "same-attempt",
    sourceSequence: 0,
    stage: "extraction",
    status: "failed",
    provenance: "provider_observed",
    sourceEventId: "same-source-event",
    inputTokens: 7,
  };
  const ledger = live().store.usage;
  expect(ledger.record("trusted-host-a", input)).toEqual({ recorded: true, duplicate: false });
  expect(ledger.record("trusted-host-b", input)).toEqual({ recorded: true, duplicate: false });
  expect(ledger.record("trusted-host-a", input)).toEqual({ recorded: true, duplicate: true });
  expect((await resources()).usage.stages.extraction).toMatchObject({
    attempts: 2,
    failed: 2,
    providerObservedAttempts: 2,
    inputTokens: { providerObserved: 14, localExact: null, estimated: null },
    observedCosts: [],
    unavailableBillingAttempts: 2,
  });
});

const cumulativeObserved: ModelUsageInput = {
  eventId: "stream-1",
  attemptId: "stream-attempt",
  sourceSequence: 1,
  stage: "review",
  status: "requested",
  provenance: "provider_observed",
  sourceEventId: "stream-source-1",
  inputTokens: 40,
  costAmount: 0.125,
  currency: "USD",
};
const cumulativeEstimated: ModelUsageInput = {
  eventId: "estimate-1",
  attemptId: "stream-attempt",
  sourceSequence: 0,
  stage: "review",
  status: "requested",
  provenance: "estimate",
  estimator: "fixture-counter",
  inputTokens: 80,
  costAmount: 0.5,
  currency: "USD",
};
const cumulativeEvents: ModelUsageInput[] = [
  cumulativeEstimated,
  cumulativeObserved,
  {
    ...cumulativeObserved,
    eventId: "stream-2",
    sourceEventId: "stream-source-2",
    sourceSequence: 2,
    status: "completed",
    inputTokens: 100,
    outputTokens: 8,
    costAmount: 0.25,
  },
  {
    ...cumulativeObserved,
    eventId: "stream-3",
    sourceEventId: "stream-source-3",
    sourceSequence: 3,
    status: "failed",
    inputTokens: null,
    outputTokens: 11,
    costAmount: null,
    currency: null,
  },
  {
    ...cumulativeEstimated,
    eventId: "estimate-2",
    sourceSequence: 4,
    status: "failed",
    inputTokens: 90,
    outputTokens: 3,
    costAmount: null,
    currency: null,
  },
];

it("uses the latest nonnull cumulative values independently for each attempt and provenance", async () => {
  for (const event of cumulativeEvents) await recordUsage(event);
  const usage = (await resources()).usage;
  expect(usage.stages.review).toMatchObject({
    attempts: 1,
    requested: 0,
    completed: 0,
    failed: 1,
    providerObservedAttempts: 1,
    estimatedAttempts: 1,
    inputTokens: { providerObserved: 100, localExact: null, estimated: 90 },
    outputTokens: { providerObserved: 11, localExact: null, estimated: 3 },
    observedCosts: [{ currency: "USD", amount: 0.25, observations: 1 }],
    estimatedCosts: [{ currency: "USD", amount: 0.5, observations: 1 }],
    unavailableBillingAttempts: 0,
  });
  expect(usage.maintenance).toEqual(usage.stages.review);
});

const maintenanceEvents: ModelUsageInput[] = [
  {
    eventId: "review-usd",
    attemptId: "review-usd",
    sourceSequence: 0,
    stage: "review",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "review-usd-source",
    inputTokens: 10,
    costAmount: 0.125,
    currency: "USD",
  },
  {
    eventId: "review-eur",
    attemptId: "review-eur",
    sourceSequence: 0,
    stage: "review",
    status: "cancelled",
    provenance: "provider_observed",
    sourceEventId: "review-eur-source",
    inputTokens: 20,
    costAmount: 0.5,
    currency: "EUR",
  },
  {
    eventId: "extract-estimate",
    attemptId: "extract-estimate",
    sourceSequence: 0,
    stage: "extraction",
    status: "failed",
    provenance: "estimate",
    estimator: "fixture-counter",
    inputTokens: 30,
    outputTokens: 5,
    costAmount: 0.25,
    currency: "USD",
  },
  {
    eventId: "consolidation-unknown",
    attemptId: "consolidation-unknown",
    sourceSequence: 0,
    stage: "consolidation",
    status: "cancelled",
    provenance: "unavailable",
  },
  {
    eventId: "validation-zero",
    attemptId: "validation-zero",
    sourceSequence: 0,
    stage: "validation",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "validation-zero-source",
    inputTokens: 0,
    outputTokens: 0,
    costAmount: 0,
    currency: "EUR",
  },
];

it("keeps maintenance stages, currencies, estimates and unsuccessful attempts separate", async () => {
  for (const event of maintenanceEvents) await recordUsage(event);
  const usage = (await resources()).usage;
  expect(usage.maintenance).toMatchObject({
    attempts: 5,
    completed: 2,
    cancelled: 2,
    failed: 1,
    inputTokens: { providerObserved: 30, localExact: null, estimated: 30 },
    outputTokens: { providerObserved: 0, localExact: null, estimated: 5 },
    estimatedCosts: [{ currency: "USD", amount: 0.25, observations: 1 }],
    unavailableBillingAttempts: 2,
    unavailableUsageAttempts: 1,
  });
  expect(usage.maintenance.observedCosts.toSorted((a, b) => a.currency.localeCompare(b.currency))).toEqual([
    { currency: "EUR", amount: 0.5, observations: 2 },
    { currency: "USD", amount: 0.125, observations: 1 },
  ]);
  expect(usage.stages.review).toMatchObject({ attempts: 2, completed: 1, cancelled: 1 });
  expect(usage.stages.extraction).toMatchObject({ attempts: 1, failed: 1, estimatedAttempts: 1 });
  expect(usage.stages.consolidation).toMatchObject({
    attempts: 1,
    cancelled: 1,
    unavailableUsageAttempts: 1,
    inputTokens: { providerObserved: null, localExact: null, estimated: null },
    observedCosts: [],
    estimatedCosts: [],
  });
  expect(usage.stages.validation.observedCosts).toEqual([{ currency: "EUR", amount: 0, observations: 1 }]);
  expect(usage.memoryInput.attempts).toBe(0);
  expect(usage.providerTurns.attempts).toBe(0);
});

const providerTurnEvents: ModelUsageInput[] = [
  {
    eventId: "provider-zero",
    attemptId: "provider-zero",
    sourceSequence: 0,
    stage: "provider_turn",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "provider-zero-source",
    inputTokens: 0,
    outputTokens: 0,
    costAmount: 0,
    currency: "USD",
  },
  {
    eventId: "provider-unbilled",
    attemptId: "provider-unbilled",
    sourceSequence: 0,
    stage: "provider_turn",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "provider-unbilled-source",
    inputTokens: 37,
  },
  {
    eventId: "provider-unavailable",
    attemptId: "provider-unavailable",
    sourceSequence: 0,
    stage: "provider_turn",
    status: "cancelled",
    provenance: "unavailable",
  },
];

it("distinguishes a provider's observed zero from absent billing and unavailable usage", async () => {
  for (const event of providerTurnEvents) await recordUsage(event);
  const usage = (await resources()).usage;
  expect(usage.providerTurns).toMatchObject({
    attempts: 3,
    completed: 2,
    cancelled: 1,
    providerObservedAttempts: 2,
    unavailableUsageAttempts: 1,
    unavailableBillingAttempts: 2,
    inputTokens: { providerObserved: 37, localExact: null, estimated: null },
    outputTokens: { providerObserved: 0, localExact: null, estimated: null },
    observedCosts: [{ currency: "USD", amount: 0, observations: 1 }],
    estimatedCosts: [],
  });
  expect(usage.maintenance.attempts).toBe(0);
  expect(usage.memoryInput.attempts).toBe(0);
});

it("requires an issued retrieval and its exact delivered reference before accepting feedback", async () => {
  const { memory, delivery } = await deliveredRecord();
  const foreign = await verifiedRecord("foreign", otherRepo);
  const unseen = await verifiedRecord("unseen");
  const before = (await resources()).feedback;
  const input: FeedbackInput = {
    eventId: "feedback-gate",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "agent_report",
    signal: "helpful",
  };
  const invalid: FeedbackInput[] = [
    { ...input, retrievalId: "never-issued-retrieval" },
    { ...input, memoryRef: foreign.memoryRef },
    { ...input, memoryRef: unseen.memoryRef },
    { ...input, memoryRef: { id: memory.memoryRef.id, revision: memory.memoryRef.revision + 1 } },
    { ...input, memoryRef: { id: 999999, revision: 1 } },
  ];
  for (const feedback of invalid) expectRefused(await internal("feedback", feedback));
  expect((await resources()).feedback).toEqual(before);
  expect(visible(foreign.memoryRef)).toMatchObject({
    application_count: 0,
    validated_helpful_count: 0,
    validated_harmful_count: 0,
  });
  expect(await recordFeedback(input)).toMatchObject({
    recorded: true,
    duplicate: false,
    validated: false,
    memoryRef: memory.memoryRef,
  });
  expect((await resources()).feedback.agentReported).toBe(before.agentReported + 1);
});

it("requires verifier identity/version and every validator evidence reference to resolve", async () => {
  const { memory, delivery } = await deliveredRecord();
  const input: FeedbackInput = {
    eventId: "validator-evidence-gate",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "validator",
    signal: "helpful",
    verifierId: "fixture/release-validator",
    verifierVersion: "1",
    evidenceRefs: memory.evidenceRefs,
  };
  for (const patch of [{ verifierId: null }, { verifierVersion: null }, { evidenceRefs: [] }]) {
    expect((await internal("feedback", { ...input, ...patch })).status).toBe(400);
  }
  const unresolved = await internal("mutate", {
    requestId: "unresolved-validation-source",
    operation: "create",
    evidence: [{ sourceKind: "artifact", sourceRef: "artifact:resource-unavailable" }],
    change: {
      title: "Unresolved verification source",
      content: "This assertion has no accessible source",
      scope: "global",
    },
  });
  expect(unresolved.status).toBe(200);
  const assertion = MutationResultSchema.parse(unresolved.body);
  expect(assertion.evidenceValidation).toBe("unresolved");
  expect(assertion.evidenceRefs).toHaveLength(1);
  for (const evidenceRefs of [["missing-evidence-id"], [...memory.evidenceRefs, ...assertion.evidenceRefs]]) {
    expectRefused(await internal("feedback", { ...input, evidenceRefs }));
  }
  expect((await resources()).feedback.validatorReported).toBe(0);
  expect(visible(memory.memoryRef).validated_helpful_count).toBe(0);
  expect(await recordFeedback(input)).toMatchObject({ recorded: true, duplicate: false, validated: true });
  expect(visible(memory.memoryRef).validated_helpful_count).toBe(1);
});

it("rechecks previously resolved validator evidence after its source becomes unresolved", async () => {
  const { memory, delivery } = await deliveredRecord();
  const input: FeedbackInput = {
    eventId: "source-current-validator",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "validator",
    signal: "helpful",
    verifierId: "fixture/release-validator",
    verifierVersion: "1",
    evidenceRefs: memory.evidenceRefs,
  };
  expect(await recordFeedback(input)).toMatchObject({ validated: true });
  const invalidated = await internal("source-invalidate", { sourceRef: memory.sourceRef });
  expect(invalidated.status).toBe(200);
  const facts = await lifecycle(memory.memoryRef);
  expect(facts.state).toBe("needs_recheck");
  expect(facts.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unresolved" })]));
  const before = (await resources()).feedback;
  expectRefused(await internal("feedback", { ...input, eventId: "after-source-invalidation" }));
  expect((await resources()).feedback).toEqual(before);
  expect(await lifecycle(memory.memoryRef)).toEqual(facts);
});

it("separates reported activity, explicit application and validated assessments without refreshing facts", async () => {
  const { memory, delivery } = await deliveredRecord();
  const facts = await lifecycle(memory.memoryRef);
  const row = visible(memory.memoryRef);
  const before = (await resources()).feedback;
  const ranking = await releaseRanking();
  expect(facts.verifiedAt).toBe(createdAt);
  expect(ranking.map((hit) => hit.id)).toContain(String(memory.memoryRef.id));
  for (const signal of ["helpful", "applied", "harmful"] as const) {
    const result = await recordFeedback({
      eventId: `agent-${signal}`,
      retrievalId: delivery.retrievalId,
      memoryRef: memory.memoryRef,
      basis: "agent_report",
      signal,
    });
    expect(result.validated).toBe(false);
  }
  expect(visible(memory.memoryRef)).toMatchObject({
    application_count: 0,
    validated_helpful_count: 0,
    validated_harmful_count: 0,
  });
  expect(await releaseRanking()).toEqual(ranking);
  setSystemTime(new Date(assessedAt));
  await recordFeedback({
    eventId: "human-application",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "human",
    signal: "applied",
  });
  for (const signal of ["helpful", "harmful"] as const) {
    const result = await recordFeedback({
      eventId: `validator-${signal}`,
      retrievalId: delivery.retrievalId,
      memoryRef: memory.memoryRef,
      basis: "validator",
      signal,
      verifierId: "fixture/release-validator",
      verifierVersion: "1",
      evidenceRefs: memory.evidenceRefs,
    });
    expect(result.validated).toBe(true);
  }
  expect((await resources()).feedback).toMatchObject({
    exposures: before.exposures,
    opens: before.opens,
    applications: 1,
    validatedHelpful: 1,
    validatedHarmful: 1,
    agentReported: 3,
    humanReported: 1,
    validatorReported: 2,
  });
  expect(visible(memory.memoryRef)).toMatchObject({
    application_count: 1,
    validated_helpful_count: 1,
    validated_harmful_count: 1,
    verified_at: row.verified_at,
    state: row.state,
    record_revision: row.record_revision,
    index_generation: row.index_generation,
    updated_at: row.updated_at,
  });
  expect(await lifecycle(memory.memoryRef)).toEqual(facts);
});

it("settles concurrent feedback retries exactly once and preserves the receipt across restart", async () => {
  const { memory, delivery } = await deliveredRecord();
  const facts = await lifecycle(memory.memoryRef);
  const input: FeedbackInput = {
    eventId: "application-once",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "human",
    signal: "applied",
  };
  const receipts = await Promise.all([recordFeedback(input), recordFeedback(input)]);
  expect(receipts.map((receipt) => receipt.duplicate).sort()).toEqual([false, true]);
  expect(receipts.map((receipt) => receipt.recorded)).toEqual([true, true]);
  expect(visible(memory.memoryRef).application_count).toBe(1);
  const conflicting = await internal("feedback", { ...input, signal: "helpful" });
  expect(conflicting.status).toBe(409);
  expect(conflicting.body).toMatchObject({ error: { code: "request_conflict" } });
  const before = (await resources()).feedback;
  expect(before).toMatchObject({ applications: 1, humanReported: 1 });
  await restart();
  expect(await recordFeedback(input)).toMatchObject({
    recorded: true,
    duplicate: true,
    memoryRef: memory.memoryRef,
  });
  expect((await resources()).feedback).toEqual(before);
  expect(visible(memory.memoryRef).application_count).toBe(1);
  expect(await lifecycle(memory.memoryRef)).toEqual(facts);
});

it("keeps feedback on an old delivered revision as history without boosting the current revision", async () => {
  const { memory, delivery } = await deliveredRecord();
  const corrected = await internal("mutate", {
    requestId: "correct-delivered-fact",
    operation: "update",
    id: memory.memoryRef.id,
    expectedRevision: memory.memoryRef.revision,
    evidenceRefs: memory.evidenceRefs,
    change: { title: "Updated presentation of the release policy" },
  });
  expect(corrected.status).toBe(200);
  const current = MutationResultSchema.parse(corrected.body);
  expect(current.memoryRef.revision).toBe(memory.memoryRef.revision + 1);
  setSystemTime(new Date(assessedAt));
  const facts = await lifecycle(current.memoryRef);
  const ranking = await releaseRanking();
  expect(ranking.map((hit) => hit.id)).toContain(String(current.memoryRef.id));
  const applied: FeedbackInput = {
    eventId: "old-revision-application",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "human",
    signal: "applied",
  };
  expect(await recordFeedback(applied)).toMatchObject({
    recorded: true,
    duplicate: false,
    memoryRef: memory.memoryRef,
  });
  expect(
    await recordFeedback({
      ...applied,
      eventId: "old-revision-validation",
      basis: "validator",
      signal: "helpful",
      evidenceRefs: memory.evidenceRefs,
      verifierId: "fixture/release-validator",
      verifierVersion: "1",
    }),
  ).toMatchObject({ recorded: true, validated: true });
  expect(visible(current.memoryRef)).toMatchObject({
    application_count: 0,
    validated_helpful_count: 0,
    validated_harmful_count: 0,
  });
  expect(await releaseRanking()).toEqual(ranking);
  expect(await lifecycle(current.memoryRef)).toEqual(facts);
  expectRefused(
    await internal("feedback", {
      ...applied,
      eventId: "new-revision-not-delivered",
      memoryRef: current.memoryRef,
    }),
  );
  const currentDelivery = await get([current.memoryRef.id]);
  expect(currentDelivery.memoryRefs).toEqual([current.memoryRef]);
  await recordFeedback({
    ...applied,
    eventId: "current-revision-application",
    retrievalId: currentDelivery.retrievalId,
    memoryRef: current.memoryRef,
  });
  expect(visible(current.memoryRef).application_count).toBe(1);
});

it("checks forget tombstones before feedback replay and never resurrects a forgotten assessment target", async () => {
  const { memory, delivery } = await deliveredRecord();
  const input: FeedbackInput = {
    eventId: "before-forget-application",
    retrievalId: delivery.retrievalId,
    memoryRef: memory.memoryRef,
    basis: "human",
    signal: "applied",
  };
  expect(await recordFeedback(input)).toMatchObject({ recorded: true, duplicate: false });
  expect(visible(memory.memoryRef).application_count).toBe(1);
  const forgotten = await internal("mutate", {
    requestId: "forget-assessed-memory",
    operation: "forget",
    id: memory.memoryRef.id,
    expectedRevision: memory.memoryRef.revision,
  });
  expect(forgotten.status).toBe(200);
  expect(MutationResultSchema.parse(forgotten.body).status).toBe("forgotten");
  const before = (await resources()).feedback;
  expectRefused(await internal("feedback", input));
  expectRefused(await internal("feedback", { ...input, eventId: "after-forget-application" }));
  expect((await resources()).feedback).toEqual(before);
  expect(live().store.getVisible(owner, [memory.memoryRef.id])).toEqual([]);
  expect((await internal("lifecycle-detail", { id: memory.memoryRef.id })).body).toBeNull();
});

it("orders delayed cumulative observations by trusted source sequence and preserves newer downward corrections", async () => {
  const completed: ModelUsageInput = {
    eventId: "source-completed",
    attemptId: "source-ordered-attempt",
    sourceSequence: 2,
    stage: "review",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "provider-completed-source",
    inputTokens: 100,
    outputTokens: 10,
    costAmount: 0.125,
    currency: "USD",
  };
  await recordUsage(completed);
  await recordUsage({
    ...completed,
    eventId: "late-source-requested",
    sourceSequence: 1,
    sourceEventId: "provider-requested-source",
    status: "requested",
    inputTokens: 40,
    outputTokens: 4,
    costAmount: 0.5,
  });
  await recordUsage({
    eventId: "late-source-estimate",
    attemptId: completed.attemptId,
    sourceSequence: 0,
    stage: "review",
    status: "requested",
    provenance: "estimate",
    estimator: "fixture-estimator",
    inputTokens: 500,
  });
  expect((await resources()).usage.stages.review).toMatchObject({
    attempts: 1,
    completed: 1,
    requested: 0,
    inputTokens: { providerObserved: 100, localExact: null, estimated: 500 },
    outputTokens: { providerObserved: 10 },
    observedCosts: [{ currency: "USD", amount: 0.125, observations: 1 }],
  });
  await recordUsage({
    ...completed,
    eventId: "newer-source-correction",
    sourceSequence: 3,
    sourceEventId: "provider-correction-source",
    inputTokens: 80,
    outputTokens: 8,
    costAmount: 0.0625,
  });
  const before = (await resources()).usage;
  expect(before.stages.review).toMatchObject({
    attempts: 1,
    completed: 1,
    requested: 0,
    inputTokens: { providerObserved: 80, localExact: null, estimated: 500 },
    outputTokens: { providerObserved: 8 },
    observedCosts: [{ currency: "USD", amount: 0.0625, observations: 1 }],
  });
  await restart();
  expect((await resources()).usage).toEqual(before);
});

it("rejects different events claiming one immutable source observation across provenance", async () => {
  const input: ModelUsageInput = {
    eventId: "source-slot-original",
    attemptId: "source-slot-attempt",
    sourceSequence: 7,
    stage: "review",
    status: "completed",
    provenance: "provider_observed",
    sourceEventId: "source-slot-provider",
    inputTokens: 23,
  };
  await recordUsage(input);
  const before = (await resources()).usage;
  const sameSourceSlot = [
    { ...input, eventId: "source-slot-renamed", sourceEventId: "different-provider-event", inputTokens: 99 },
    {
      ...input,
      eventId: "source-slot-estimated",
      sourceEventId: null,
      provenance: "estimate",
      estimator: "fixture-estimator",
      inputTokens: 500,
    },
  ];
  for (const observation of sameSourceSlot) {
    const conflict = await internal("usage-record", observation);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "request_conflict" } });
  }
  expect((await resources()).usage).toEqual(before);
  expect(await recordUsage(input)).toEqual({ recorded: true, duplicate: true });
  await recordUsage({
    ...input,
    eventId: "source-slot-correction",
    sourceSequence: 8,
    sourceEventId: "source-slot-provider-correction",
    inputTokens: 11,
  });
  await recordUsage({
    ...input,
    eventId: "source-slot-other-stage",
    sourceEventId: "source-slot-extraction-provider",
    stage: "extraction",
    inputTokens: 5,
  });
  const usage = (await resources()).usage;
  expect(usage.stages.review).toMatchObject({ attempts: 1, inputTokens: { providerObserved: 11 } });
  expect(usage.stages.extraction).toMatchObject({ attempts: 1, inputTokens: { providerObserved: 5 } });
  expect(usage.maintenance).toMatchObject({ attempts: 2, inputTokens: { providerObserved: 16 } });
});
