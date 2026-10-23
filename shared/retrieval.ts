import { z } from "zod";
import { MemoryRefSchema, RecordKindSchema } from "./lifecycle";

export const RetrievalProfileNameSchema = z.enum(["compact", "standard", "evidence"]);
export type RetrievalProfileName = z.infer<typeof RetrievalProfileNameSchema>;
export const RetrievalDetailSchema = z.enum(["references", "compact", "full"]);
export type RetrievalDetail = z.infer<typeof RetrievalDetailSchema>;
export const RetrievalRerankModeSchema = z.enum(["auto", "on", "off"]);
export type RerankMode = z.infer<typeof RetrievalRerankModeSchema>;
export type RecordKind = z.infer<typeof RecordKindSchema>;

export const RETRIEVAL_ABSOLUTE_LIMITS = {
  maxTokens: 32768,
  maxChars: 20000,
  maxBytes: 80000,
  maxLatencyMs: 5000,
  maxCandidates: 200,
  maxItems: 100,
} as const;
export const RETRIEVAL_BUDGET_KEYS = [
  "maxTokens",
  "maxChars",
  "maxBytes",
  "maxLatencyMs",
  "maxCandidates",
  "maxItems",
] as const;
const bounded = (maximum: number) => z.number().int().min(0).max(maximum);
export const RetrievalBudgetSchema = z.strictObject({
  maxTokens: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxTokens),
  maxChars: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxChars),
  maxBytes: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxBytes),
  maxLatencyMs: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxLatencyMs),
  maxCandidates: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxCandidates),
  maxItems: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxItems),
});
export type RetrievalBudget = z.infer<typeof RetrievalBudgetSchema>;
export const RetrievalProfileSchema = RetrievalBudgetSchema.extend({
  rerankMode: RetrievalRerankModeSchema,
  allowedRecordKinds: z.array(RecordKindSchema).max(RecordKindSchema.options.length),
  detail: RetrievalDetailSchema,
});
export type RetrievalProfile = z.infer<typeof RetrievalProfileSchema>;

const stableKinds: RecordKind[] = ["fact", "preference", "derived_summary", "lesson"];
const standardProfile: RetrievalProfile = {
  maxTokens: 8192,
  maxChars: 6000,
  maxBytes: 18000,
  maxLatencyMs: 750,
  maxCandidates: 60,
  maxItems: 40,
  rerankMode: "auto",
  allowedRecordKinds: [...stableKinds, "episode"],
  detail: "compact",
};
const defaultProfiles: Record<RetrievalProfileName, RetrievalProfile> = {
  compact: {
    ...standardProfile,
    maxTokens: 4096,
    maxChars: 3000,
    maxBytes: 9000,
    maxLatencyMs: 500,
    maxCandidates: 30,
    maxItems: 20,
    allowedRecordKinds: [...stableKinds],
  },
  standard: standardProfile,
  evidence: {
    ...standardProfile,
    maxTokens: 32768,
    maxChars: 20000,
    maxBytes: 60000,
    maxLatencyMs: 2000,
    maxCandidates: 120,
    maxItems: 80,
    detail: "full",
  },
};
export const RetrievalPolicySettingsSchema = z
  .strictObject({
    defaultProfile: RetrievalProfileNameSchema.default("standard"),
    allowedProfiles: z.array(RetrievalProfileNameSchema).min(1).max(3).default(["compact", "standard"]),
    profiles: z
      .strictObject({
        compact: RetrievalProfileSchema.default(defaultProfiles.compact),
        standard: RetrievalProfileSchema.default(defaultProfiles.standard),
        evidence: RetrievalProfileSchema.default(defaultProfiles.evidence),
      })
      .default(defaultProfiles),
    reservedTokens: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxTokens).default(1024),
    reservedChars: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxChars).default(1024),
    reservedBytes: bounded(RETRIEVAL_ABSOLUTE_LIMITS.maxBytes).default(4096),
  })
  .refine((policy) => policy.allowedProfiles.includes(policy.defaultProfile), {
    path: ["defaultProfile"],
    message: "The default retrieval profile must be allowed.",
  });
export type RetrievalPolicySettings = z.infer<typeof RetrievalPolicySettingsSchema>;
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicySettings = RetrievalPolicySettingsSchema.parse({});

// Requests can only narrow an owner budget; safe integers above owner caps are clamped at resolution.
const requestedLimit = bounded(Number.MAX_SAFE_INTEGER).optional();
export const RetrievalRequestSchema = z.strictObject({
  profile: RetrievalProfileNameSchema.optional(),
  budget: z
    .strictObject({
      maxTokens: requestedLimit,
      maxChars: requestedLimit,
      maxBytes: requestedLimit,
      maxLatencyMs: requestedLimit,
      maxCandidates: requestedLimit,
      maxItems: requestedLimit,
    })
    .optional(),
  recordKinds: z.array(RecordKindSchema).max(RecordKindSchema.options.length).optional(),
  detail: RetrievalDetailSchema.optional(),
  ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(20).optional(),
  query: z.string().max(500).optional(),
  tokenizerId: z.string().min(1).max(200).optional(),
});
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const RetrievalResultSchema = z.strictObject({
  retrievalId: z.string().min(1),
  contextText: z.string(),
  memoryRefs: z.array(MemoryRefSchema),
  evidenceRefs: z.array(z.string()),
  sessionIds: z.array(z.string()),
  taskIds: z.array(z.number().int().positive()),
  usage: z.strictObject({
    tokenCount: count,
    tokenCountIsEstimate: z.boolean(),
    estimator: z.string().min(1),
    chars: count,
    bytes: count,
    latencyMs: z.number().min(0),
    reservedTokens: count,
    reservedChars: count,
    reservedBytes: count,
    assembledChars: count,
    assembledBytes: count,
    assembledTokenCount: count,
  }),
  truncated: z.boolean(),
  omittedCount: count,
  omittedPins: count,
  fallbackReason: z.string().nullable(),
  policyRevision: count,
  indexGeneration: count,
});
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;
