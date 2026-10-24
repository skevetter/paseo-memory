import { z } from "zod";
import { InferenceQueueSnapshotSchema, InferenceStageSnapshotSchema } from "./inference";
import { MemoryRefSchema } from "./lifecycle";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(200);
const optionalIdentifier = identifier.nullable().default(null);
export const ModelUsageStageSchema = z.enum([
  "memory_input",
  "review",
  "extraction",
  "consolidation",
  "validation",
  "provider_turn",
]);
export type ModelUsageStage = z.infer<typeof ModelUsageStageSchema>;
export const UsageProvenanceSchema = z.enum(["provider_observed", "local_exact", "estimate", "unavailable"]);
export const UsageStatusSchema = z.enum([
  "prepared",
  "attached",
  "discarded",
  "requested",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const ModelUsageBaseSchema = z.strictObject({
  eventId: identifier,
  attemptId: identifier,
  sourceSequence: count,
  stage: ModelUsageStageSchema,
  status: UsageStatusSchema,
  provenance: UsageProvenanceSchema,
  model: optionalIdentifier,
  inputTokens: count.nullable().default(null),
  outputTokens: count.nullable().default(null),
  costAmount: z.number().finite().min(0).nullable().default(null),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  sourceEventId: optionalIdentifier,
  retrievalId: optionalIdentifier,
  jobId: optionalIdentifier,
  estimator: optionalIdentifier,
  durationMs: z.number().finite().min(0).nullable().default(null),
});
export const ModelUsageInputSchema = ModelUsageBaseSchema.superRefine((input, ctx) => {
  if ((input.costAmount === null) !== (input.currency === null))
    ctx.addIssue({
      code: "custom",
      path: ["currency"],
      message: "A recorded monetary value requires its currency.",
    });
  const observed = input.inputTokens !== null || input.outputTokens !== null || input.costAmount !== null;
  if (input.provenance === "unavailable" && observed)
    ctx.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "Unavailable usage must remain unknown, not zero or an estimate.",
    });
  if (input.provenance === "provider_observed" && (!input.sourceEventId || !observed))
    ctx.addIssue({
      code: "custom",
      path: ["sourceEventId"],
      message: "Provider observations require an identified source event and an observed value.",
    });
  const localIssue = localUsageIssue(input);
  if (localIssue) ctx.addIssue({ code: "custom", ...localIssue });
});
export type ModelUsageInput = z.input<typeof ModelUsageInputSchema>;
export type ParsedModelUsage = z.output<typeof ModelUsageInputSchema>;

function localUsageIssue(input: z.infer<typeof ModelUsageBaseSchema>) {
  if ((input.provenance === "local_exact" || input.provenance === "estimate") && !input.estimator)
    return {
      path: ["estimator"],
      message: "Local counts and estimates identify their counter or estimator.",
    };
  if (
    input.provenance === "local_exact" &&
    (input.stage !== "memory_input" ||
      input.inputTokens === null ||
      input.outputTokens !== null ||
      input.costAmount !== null)
  )
    return {
      path: ["provenance"],
      message: "An exact local fragment counter is not observed provider billing.",
    };
  return null;
}

export const FeedbackInputSchema = z
  .strictObject({
    eventId: identifier,
    retrievalId: identifier,
    memoryRef: MemoryRefSchema,
    signal: z.enum(["applied", "helpful", "harmful", "irrelevant"]),
    basis: z.enum(["validator", "human", "agent_report"]),
    evidenceRefs: z.array(identifier).max(32).default([]),
    verifierId: optionalIdentifier,
    verifierVersion: optionalIdentifier,
    runId: optionalIdentifier,
    cycleId: optionalIdentifier,
  })
  .superRefine((input, ctx) => {
    if (
      input.basis === "validator" &&
      (!input.verifierId || !input.verifierVersion || input.evidenceRefs.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "Validator feedback requires its verifier/version and resolvable evidence.",
      });
  });
export type FeedbackInput = z.input<typeof FeedbackInputSchema>;
export type ParsedFeedback = z.output<typeof FeedbackInputSchema>;
export const FeedbackResultSchema = z.object({
  recorded: z.boolean(),
  duplicate: z.boolean(),
  validated: z.boolean(),
  memoryRef: MemoryRefSchema,
});
export type FeedbackResult = z.infer<typeof FeedbackResultSchema>;

const TokenTotalsSchema = z.object({
  providerObserved: count.nullable(),
  localExact: count.nullable(),
  estimated: count.nullable(),
});
export const UsageTotalsSchema = z.object({
  attempts: count,
  prepared: count,
  attached: count,
  discarded: count,
  requested: count,
  completed: count,
  failed: count,
  cancelled: count,
  unknown: count,
  inputTokens: TokenTotalsSchema,
  outputTokens: TokenTotalsSchema,
  observedCosts: z.array(z.object({ currency: z.string(), amount: z.number().min(0), observations: count })),
  estimatedCosts: z.array(z.object({ currency: z.string(), amount: z.number().min(0), observations: count })),
  unavailableBillingAttempts: count,
  providerObservedAttempts: count,
  localExactAttempts: count,
  estimatedAttempts: count,
  unavailableUsageAttempts: count,
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
export const ResourceUsageSchema = z.object({
  observedSince: z.string().nullable(),
  memoryInput: UsageTotalsSchema,
  maintenance: UsageTotalsSchema,
  providerTurns: UsageTotalsSchema,
  stages: z.object({
    review: UsageTotalsSchema,
    extraction: UsageTotalsSchema,
    consolidation: UsageTotalsSchema,
    validation: UsageTotalsSchema,
  }),
  attribution: z.literal(
    "Fragment counts are not provider billing or causal usefulness; absent provider values remain unknown. Native turn counts are incomplete host observations: missing IDs are omitted and reopened turn IDs can coalesce.",
  ),
});
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;
export const ModelIndexStatusSchema = z.object({
  fingerprint: z.string(),
  generation: count,
  model: z.string(),
  dims: count,
  state: z.enum(["building", "ready", "retired", "legacy"]),
  entries: count,
  identityKnown: z.boolean(),
  createdAt: z.string().nullable(),
  readyAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  indexBytes: count.nullable(),
  artifactBytes: count.nullable(),
});
export type ModelIndexStatus = z.infer<typeof ModelIndexStatusSchema>;
export const ResourceStatusSchema = z.object({
  observedAt: z.string(),
  rerankerFingerprint: z.string().nullable(),
  observationEpoch: z.string().nullable(),
  process: z.object({
    cpuUserMicros: count,
    cpuSystemMicros: count,
    rssBytes: count,
    heapUsedBytes: count,
    uptimeMs: z.number().min(0),
    basis: z.literal("process_cumulative_not_per_request"),
  }),
  inference: InferenceQueueSnapshotSchema,
  retrieval: InferenceStageSnapshotSchema,
  indexes: z.object({
    servingFingerprint: z.string().nullable(),
    readyFingerprint: z.string().nullable(),
    targetFingerprint: z.string().nullable(),
    corpusRecords: count,
    eligibleRecords: count,
    currentEntries: count,
    databaseBytes: count,
    retention: z.object({ maxRetired: count, retiredDays: count }),
    items: z.array(ModelIndexStatusSchema),
  }),
  usage: ResourceUsageSchema,
  feedback: z.object({
    exposures: count,
    opens: count,
    applications: count,
    validatedHelpful: count,
    validatedHarmful: count,
    agentReported: count,
    humanReported: count,
    validatorReported: count,
    basis: z.literal(
      "Exposures/opens are cumulative; application and validated counters belong to current revisions, not causal improvement or verified factual freshness.",
    ),
  }),
});
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;
