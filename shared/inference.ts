import { z } from "zod";

export const INFERENCE_STAGES = ["document_embedding", "query_embedding", "rerank"] as const;
export const InferenceStageSchema = z.enum(INFERENCE_STAGES);
export type InferenceStage = z.infer<typeof InferenceStageSchema>;

export const INFERENCE_QUEUE_DEFAULTS = { concurrency: 2, maxPending: 32 } as const;
export const INFERENCE_QUEUE_HARD_LIMITS = { concurrency: 8, maxPending: 256 } as const;
export const INFERENCE_LATENCY_HISTORY_LIMIT = 256;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const InferenceQueueCountsSchema = z.strictObject({
  completed: count,
  failed: count,
  cancelled: count,
  rejected: count,
});
export type InferenceQueueCounts = z.infer<typeof InferenceQueueCountsSchema>;

export const InferenceQueueLatencySchema = z.strictObject({
  p50: z.number().min(0).nullable(),
  p95: z.number().min(0).nullable(),
  samples: count.max(INFERENCE_LATENCY_HISTORY_LIMIT),
});
export const InferenceStageSnapshotSchema = z.strictObject({
  counts: InferenceQueueCountsSchema,
  latencyMs: InferenceQueueLatencySchema,
});
export type InferenceStageSnapshot = z.infer<typeof InferenceStageSnapshotSchema>;

export const InferenceQueueSnapshotSchema = z.strictObject({
  active: count.max(INFERENCE_QUEUE_HARD_LIMITS.concurrency),
  pending: count.max(INFERENCE_QUEUE_HARD_LIMITS.maxPending),
  // Nonempty queues round age up to at least 1ms; zero means empty.
  oldestQueuedMs: z.number().min(0),
  limits: z.strictObject({
    concurrency: z.number().int().min(1).max(INFERENCE_QUEUE_HARD_LIMITS.concurrency),
    maxPending: count.max(INFERENCE_QUEUE_HARD_LIMITS.maxPending),
  }),
  counts: InferenceQueueCountsSchema,
  latencyMs: InferenceQueueLatencySchema,
  stages: z.strictObject({
    document_embedding: InferenceStageSnapshotSchema,
    query_embedding: InferenceStageSnapshotSchema,
    rerank: InferenceStageSnapshotSchema,
  }),
});
export type InferenceQueueSnapshot = z.infer<typeof InferenceQueueSnapshotSchema>;
