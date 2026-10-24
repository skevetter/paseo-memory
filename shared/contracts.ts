import { defineAttachmentSource, defineRpc, defineSettings, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { BridgeSettingsSchema } from "./bridge";
import {
  ForgetPreviewSchema,
  LifecycleDetailSchema,
  MutationRequestSchema,
  MutationResultSchema,
} from "./lifecycle";
import { MemoryScopeSchema } from "./namespaces";
import { ResourceStatusSchema } from "./resources";
import { RetrievalPolicySettingsSchema } from "./retrieval";
import {
  AgentAuditSchema,
  DEFAULT_RUNTIME,
  DETAIL_LEVELS,
  EMBEDDING_TIERS,
  EvidenceArtifactInputSchema,
  HistoricalMemorySchema,
  MAX_CONTENT_CHARS,
  MEMORY_TYPES,
  MERGE_MODES,
  MemoryDetailSchema,
  MemoryItemSchema,
  RERANK_MODES,
  REVIEW_DISPLAYS,
  type ReviewDisplay,
  type RuntimeConfig,
  SearchScopeSchema,
  SessionItemSchema,
  STRICTNESS_LEVELS,
  serviceInputs,
  UpkeepListSchema,
  WorkspaceAgentSchema,
} from "./service-api";

export const PLUGIN_ID = "paseo-memory";

export type {
  AgentAudit,
  AuditEvent,
  MemoryDetail,
  MemoryItem,
  SessionItem,
  UpkeepList,
  WorkspaceAgent,
} from "./service-api";
export { MAX_CONTENT_CHARS, MEMORY_TYPES, SearchScopeSchema };
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);

export const REVIEW_MODES = ["off", "idle", "turns"] as const;
export { REVIEW_DISPLAYS, type ReviewDisplay };

export interface NumberRange {
  min: number;
  max: number;
  step: number;
}

export const RANGES = {
  contextBudgetChars: { min: 500, max: 20000, step: 500 },
  maxPinned: { min: 0, max: 50, step: 1 },
  taskMatches: { min: 0, max: 50, step: 1 },
  projectMemories: { min: 0, max: 50, step: 1 },
  globalMemories: { min: 0, max: 50, step: 1 },
  recentSessions: { min: 0, max: 20, step: 1 },
  reviewIdleMinutes: { min: 1, max: 240, step: 1 },
  reviewEveryTurns: { min: 2, max: 100, step: 1 },
  reviewMaxMemories: { min: 0, max: 10, step: 1 },
  staleDays: { min: 7, max: 365, step: 1 },
  sessionRetentionDays: { min: 1, max: 365, step: 1 },
} as const satisfies Record<string, NumberRange>;

type RangedKey = keyof typeof RANGES;

const ranged = (key: RangedKey, fallback: number) =>
  z.number().int().min(RANGES[key].min).max(RANGES[key].max).default(fallback);

const settingsSchema = z.object({
  injectContext: z.boolean().default(true),
  injectMcp: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  contextBudgetChars: ranged("contextBudgetChars", DEFAULT_RUNTIME.contextBudgetChars),
  retrievalPolicy: RetrievalPolicySettingsSchema.default(DEFAULT_RUNTIME.retrievalPolicy),
  bridge: BridgeSettingsSchema.default(DEFAULT_RUNTIME.bridge),
  maxPinned: ranged("maxPinned", DEFAULT_RUNTIME.maxPinned),
  taskMatches: ranged("taskMatches", DEFAULT_RUNTIME.taskMatches),
  taskStrictness: z.enum(STRICTNESS_LEVELS).default(DEFAULT_RUNTIME.taskStrictness),
  projectMemories: ranged("projectMemories", DEFAULT_RUNTIME.projectMemories),
  globalMemories: ranged("globalMemories", DEFAULT_RUNTIME.globalMemories),
  recentSessions: ranged("recentSessions", DEFAULT_RUNTIME.recentSessions),
  detailLevel: z.enum(DETAIL_LEVELS).default(DEFAULT_RUNTIME.detailLevel),
  extraInstructions: z.string().max(2000).default(""),
  reviewTrigger: z.enum(REVIEW_MODES).default("idle"),
  reviewIdleMinutes: ranged("reviewIdleMinutes", 10),
  reviewEveryTurns: ranged("reviewEveryTurns", 8),
  reviewMaxMemories: ranged("reviewMaxMemories", DEFAULT_RUNTIME.reviewMaxMemories),
  reviewDisplay: z.enum(REVIEW_DISPLAYS).default("collapsed"),
  duplicateMerge: z.enum(MERGE_MODES).default(DEFAULT_RUNTIME.duplicateMerge),
  staleDays: ranged("staleDays", DEFAULT_RUNTIME.staleDays),
  usageRanking: z.boolean().default(DEFAULT_RUNTIME.usageRanking),
  embeddingTier: z.enum(EMBEDDING_TIERS).default("medium"),
  // auto: on for the medium and high tiers, off for zero and low.
  rerank: z.enum(RERANK_MODES).default("auto"),
  mcpPort: z.number().int().min(1024).max(65535).default(6797),
  // Applies to session digests and agent audit events.
  sessionRetentionDays: ranged("sessionRetentionDays", 30),
  mcpDenyProviders: z.array(z.string()).default(["pi"]),
  // Empty means auto-detect: bun on PATH, Homebrew SQLite on macOS, and the plugin directory from config.json.
  bunPath: z.string().default(""),
  sqlitePath: z.string().default(""),
  servicePath: z.string().default(""),
});

export const memorySettings = defineSettings({
  id: "memory",
  scope: "host",
  version: 4,
  schema: settingsSchema,
  migrate(values) {
    const {
      embeddings: _e,
      duplicateThreshold: _d,
      sqliteVecPath: _s,
      ...kept
    } = z.record(z.string(), z.unknown()).parse(values ?? {});
    return kept;
  },
});

export type MemorySettings = z.output<typeof settingsSchema>;

export function runtimeConfig(settings: MemorySettings): RuntimeConfig {
  return {
    contextBudgetChars: settings.contextBudgetChars,
    retrievalPolicy: settings.retrievalPolicy,
    bridge: settings.bridge,
    maxPinned: settings.maxPinned,
    taskMatches: settings.taskMatches,
    taskStrictness: settings.taskStrictness,
    projectMemories: settings.projectMemories,
    globalMemories: settings.globalMemories,
    recentSessions: settings.recentSessions,
    detailLevel: settings.detailLevel,
    extraInstructions: settings.extraInstructions,
    reviewMaxMemories: settings.reviewMaxMemories,
    duplicateMerge: settings.duplicateMerge,
    staleDays: settings.staleDays,
    usageRanking: settings.usageRanking,
  };
}

export const searchMemoriesRpc = defineRpc({
  name: "memory.search",
  input: z.object({
    query: z.string(),
    paseoProjectId: z.string().nullable(),
    scope: SearchScopeSchema.default("all"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(MemoryItemSchema) }),
});

export const mutateMemoryRpc = defineRpc({
  name: "memory.mutate",
  input: MutationRequestSchema,
  output: MutationResultSchema,
});
export const memoryLifecycleRpc = defineRpc({
  name: "memory.lifecycle",
  input: serviceInputs["lifecycle-detail"],
  output: LifecycleDetailSchema.nullable(),
});
export const memoryHistoricalRpc = defineRpc({
  name: "memory.historical",
  input: serviceInputs.historical,
  output: HistoricalMemorySchema.nullable(),
});
export const forgetPreviewRpc = defineRpc({
  name: "memory.forget.preview",
  input: serviceInputs["forget-preview"],
  output: ForgetPreviewSchema,
});
export const evidenceArtifactRpc = defineRpc({
  name: "memory.evidence.artifact",
  input: EvidenceArtifactInputSchema,
  output: z.object({ sourceRef: z.string(), sourceHash: z.string() }),
});
export const invalidateSourceRpc = defineRpc({
  name: "memory.source.invalidate",
  input: serviceInputs["source-invalidate"],
  output: z.object({ affected: z.number().int() }),
});
export const forgetSourceRpc = defineRpc({
  name: "memory.source.forget",
  input: serviceInputs["source-forget"],
  output: z.object({ forgotten: z.number().int() }),
});

export const saveMemoryRpc = defineRpc({
  name: "memory.save",
  input: z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(MAX_CONTENT_CHARS),
    type: MemoryTypeSchema.default("note"),
    scope: MemoryScopeSchema.default("project"),
    botId: z.string().min(1).max(200).nullable().default(null),
    paseoProjectId: z.string().nullable(),
    pinned: z.boolean().default(false),
    requestId: z.string().min(1).max(200).optional(),
  }),
  output: MutationResultSchema.extend({ id: z.number(), message: z.string() }),
});

export const updateMemoryRpc = defineRpc({
  name: "memory.update",
  input: z.object({
    id: z.number().int(),
    expectedRevision: z.number().int().positive(),
    requestId: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(MAX_CONTENT_CHARS).optional(),
    type: MemoryTypeSchema.optional(),
    pinned: z.boolean().optional(),
    scope: MemoryScopeSchema.optional(),
    botId: z.string().min(1).max(200).nullable().optional(),
    // Required when scope changes to project.
    paseoProjectId: z.string().nullable().optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const deleteMemoryRpc = defineRpc({
  name: "memory.delete",
  input: serviceInputs.delete,
  output: z.object({ ok: z.boolean() }),
});

export const memoryDetailRpc = defineRpc({
  name: "memory.detail",
  input: z.object({ id: z.number().int() }),
  output: MemoryDetailSchema,
});

export const restoreMemoryRpc = defineRpc({
  name: "memory.restore",
  input: serviceInputs.restore,
  output: z.object({ ok: z.boolean() }),
});

export const mergeMemoryRpc = defineRpc({
  name: "memory.merge",
  input: z.object({
    sourceId: z.number().int(),
    targetId: z.number().int(),
    sourceRevision: z.number().int(),
    targetRevision: z.number().int(),
    requestId: z.string().min(1).max(200).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    mergeId: z.number().nullable(),
    conflict: z.boolean(),
  }),
});

export const undoMergeRpc = defineRpc({
  name: "memory.merge.undo",
  input: serviceInputs["merge-undo"],
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const sessionsRpc = defineRpc({
  name: "memory.sessions",
  input: z.object({
    query: z.string().default(""),
    paseoProjectId: z.string().nullable(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(SessionItemSchema) }),
});

export const agentAuditRpc = defineRpc({
  name: "memory.agent-audit",
  input: z.object({ agentId: z.string().min(1) }),
  output: AgentAuditSchema,
});

export const workspaceAgentsRpc = defineRpc({
  name: "memory.workspace-agents",
  input: z.object({ workspaceId: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({ agents: z.array(WorkspaceAgentSchema) }),
});

export const upkeepListRpc = defineRpc({
  name: "memory.upkeep.list",
  input: z.object({ paseoProjectId: z.string().nullable() }),
  output: UpkeepListSchema,
});

export const upkeepRunRpc = defineRpc({
  name: "memory.upkeep.run",
  input: z.object({}),
  output: z.object({
    merged: z.number(),
    duplicates: z.number(),
    conflicts: z.number(),
    stale: z.number(),
  }),
});

export const keepMemoryRpc = defineRpc({
  name: "memory.keep",
  input: z.object({ id: z.number().int() }),
  output: z.object({ ok: z.boolean() }),
});

export const archiveMemoryRpc = defineRpc({
  name: "memory.archive",
  input: serviceInputs.archive,
  output: z.object({ ok: z.boolean() }),
});

export const dismissPairRpc = defineRpc({
  name: "memory.dismiss-pair",
  input: z.object({ a: z.number().int(), b: z.number().int() }),
  output: z.object({ ok: z.boolean() }),
});

export const ServiceStateSchema = z.enum(["starting", "running", "restarting", "fatal", "stopped"]);

const PathInfoSchema = z.object({
  value: z.string().nullable(),
  source: z.enum(["override", "detected"]),
});

export const statusRpc = defineRpc({
  name: "memory.status",
  input: z.object({}),
  output: z.object({
    resources: ResourceStatusSchema.nullable(),
    service: z.object({
      state: ServiceStateSchema,
      detail: z.string().nullable(),
      bunPath: z.string().nullable(),
      bunVersion: z.string().nullable(),
      servicePath: z.string().nullable(),
      servicePathSource: z.string().nullable(),
      pid: z.number().nullable(),
      restarts: z.number(),
    }),
    paths: z.object({ bun: PathInfoSchema, sqlite: PathInfoSchema, service: PathInfoSchema }),
    live: z
      .object({
        version: z.string(),
        bunVersion: z.string(),
        sqliteVersion: z.string(),
        sqliteLibrary: z.string().nullable(),
        sqliteVecVersion: z.string(),
        dbPath: z.string(),
        mcpUrl: z.string(),
        memories: z.number(),
        sessions: z.number(),
        projects: z.number(),
        embedder: z.object({
          tier: z.enum(EMBEDDING_TIERS),
          model: z.string(),
          dims: z.number(),
          state: z.enum(["loading", "ready", "error"]),
          error: z.string().nullable(),
          pending: z.number(),
          failed: z.number(),
          indexError: z.string().nullable(),
        }),
        reranker: z.object({
          mode: z.enum(RERANK_MODES),
          enabled: z.boolean(),
          model: z.string(),
          state: z.enum(["off", "loading", "ready", "error"]),
          error: z.string().nullable(),
        }),
      })
      .nullable(),
  }),
});

export type MemoryStatus = RpcOutput<typeof statusRpc>;

const AttachmentPayloadSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
      url: z.string().url(),
      text: z.string(),
      resourceType: z.string(),
    }),
  ),
});

export const attachmentSearchRpc = defineRpc({
  name: "memory.attachments.search",
  input: z.object({ query: z.string() }),
  output: AttachmentPayloadSchema,
});

export const memoryAttachments = defineAttachmentSource({
  id: "memory",
  title: "Memory",
  icon: "Brain",
  pickerTitle: "Attach a memory",
  searchPlaceholder: "Search project and global memory",
  search: attachmentSearchRpc,
});
