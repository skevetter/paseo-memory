import { z } from "zod";

export const TimestampSchema = z.iso.datetime().transform((value) => new Date(value).toISOString());
export const RecordKindSchema = z.enum([
  "fact",
  "preference",
  "episode",
  "derived_summary",
  "lesson",
  "procedure_ref",
]);
export const RecordStateSchema = z.enum([
  "candidate",
  "active",
  "rejected",
  "superseded",
  "needs_recheck",
  "archived",
]);
export const VerificationSchema = z.enum(["unverified", "verified", "unresolved"]);
export const MemoryRefSchema = z.strictObject({
  id: z.number().int().positive(),
  revision: z.number().int().positive(),
});
export type MemoryRef = z.infer<typeof MemoryRefSchema>;
export const EvidenceInputSchema = z.strictObject({
  sourceKind: z.enum(["memory", "artifact"]),
  sourceRef: z.string().min(1).max(1000),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sourceEventAt: TimestampSchema.optional(),
  includeExcerpt: z.boolean().default(false),
});
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
export const EvidenceSchema = z.object({
  evidenceId: z.string(),
  sourceKind: z.string(),
  sourceRef: z.string(),
  sourceHash: z.string().nullable(),
  observedAt: z.string().nullable(),
  sourceEventAt: z.string().nullable(),
  storedAt: z.string(),
  status: z.enum(["resolved", "unresolved"]),
  reason: z.string().nullable(),
  excerpt: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
const ChangeSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
  type: z.string().min(1).max(50).optional(),
  scope: z.enum(["global", "project"]).optional(),
  project: z
    .strictObject({
      key: z.string(),
      name: z.string(),
      rootPath: z.string().nullable(),
      paseoProjectId: z.string().nullable(),
    })
    .nullable()
    .optional(),
  topicKey: z.string().max(200).nullable().optional(),
  pinned: z.boolean().optional(),
  recordKind: RecordKindSchema.optional(),
  state: RecordStateSchema.optional(),
  validFrom: TimestampSchema.nullable().optional(),
  validUntil: TimestampSchema.nullable().optional(),
  sourceRevision: z.number().int().positive().optional(),
  target: MemoryRefSchema.optional(),
  mergeId: z.number().int().positive().optional(),
});
export const MutationRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  operation: z.enum([
    "create",
    "propose",
    "update",
    "supersede",
    "archive",
    "restore",
    "merge",
    "undo_merge",
    "promote",
    "reject",
    "forget",
  ]),
  id: z.number().int().positive().optional(),
  expectedRevision: z.number().int().positive().optional(),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(32).default([]),
  evidence: z.array(EvidenceInputSchema).max(16).default([]),
  reason: z.string().max(500).default(""),
  change: ChangeSchema.default({}),
});
export type MutationRequest = z.input<typeof MutationRequestSchema>;
export type ParsedMutation = z.output<typeof MutationRequestSchema>;
export const MutationResultSchema = z.object({
  status: z.enum(["created", "updated", "duplicate", "unchanged", "forgotten"]),
  memoryRef: MemoryRefSchema,
  state: RecordStateSchema,
  evidenceValidation: z.enum(["resolved", "unresolved", "none"]),
  evidenceRefs: z.array(z.string()),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;
export const LifecycleDetailSchema = z.object({
  memoryRef: MemoryRefSchema,
  recordKind: RecordKindSchema,
  state: RecordStateSchema,
  verificationStatus: VerificationSchema,
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  revisions: z.array(
    z.object({
      revision: z.number(),
      snapshot: z.record(z.string(), z.unknown()),
      changedAt: z.string(),
      actorId: z.string().nullable(),
      reason: z.string().nullable(),
      legacyMetadataUnknown: z.boolean(),
    }),
  ),
});
export type LifecycleDetail = z.infer<typeof LifecycleDetailSchema>;
export const ForgetPreviewSchema = z.object({
  records: z.array(MemoryRefSchema),
  evidenceIds: z.array(z.string()),
  sources: z.array(z.string()),
  affectedAgentIds: z.array(z.string()),
  limits: z.array(z.string()),
});
export type ForgetPreview = z.infer<typeof ForgetPreviewSchema>;
