import { z } from "zod";

export const SERVICE_KEY_HEADER = "x-paseo-memory-key";
export const SERVICE_KEY_LABEL = "paseo-memory/internal-api/v1";
export const SERVICE_EVENT_PREFIX = "@@paseo-memory ";
export const FATAL_EXIT_CODE = 78;
export const NONCE_ENV = "PASEO_MEMORY_NONCE";
// Hard cap; the agent instructions ask for about 800 characters.
export const MAX_CONTENT_CHARS = 4000;

export const EMBEDDING_TIERS = ["zero", "low", "medium", "high"] as const;
export type EmbeddingTier = (typeof EMBEDDING_TIERS)[number];

export const RERANK_MODES = ["auto", "on", "off"] as const;
export type RerankMode = (typeof RERANK_MODES)[number];

export const STRICTNESS_LEVELS = ["low", "medium", "high"] as const;
export type Strictness = (typeof STRICTNESS_LEVELS)[number];

export const DETAIL_LEVELS = ["titles", "summaries"] as const;
export const MERGE_MODES = ["off", "suggest", "auto"] as const;
export const REVIEW_TRIGGERS = ["idle", "turns"] as const;
export const TASK_SOURCES = ["prompt", "names"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
export const REVIEW_DISPLAYS = ["collapsed", "full", "hidden"] as const;
export type ReviewDisplay = (typeof REVIEW_DISPLAYS)[number];

export const RuntimeConfigSchema = z.object({
  contextBudgetChars: z.number().int().min(500),
  maxPinned: z.number().int().min(0),
  taskMatches: z.number().int().min(0),
  taskStrictness: z.enum(STRICTNESS_LEVELS),
  projectMemories: z.number().int().min(0),
  globalMemories: z.number().int().min(0),
  recentSessions: z.number().int().min(0),
  detailLevel: z.enum(DETAIL_LEVELS),
  extraInstructions: z.string(),
  reviewMaxMemories: z.number().int().min(0),
  duplicateMerge: z.enum(MERGE_MODES),
  staleDays: z.number().int().min(1),
  usageRanking: z.boolean(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const DEFAULT_RUNTIME: RuntimeConfig = {
  contextBudgetChars: 6000,
  maxPinned: 10,
  taskMatches: 5,
  taskStrictness: "medium",
  projectMemories: 15,
  globalMemories: 8,
  recentSessions: 3,
  detailLevel: "titles",
  extraInstructions: "",
  reviewMaxMemories: 3,
  duplicateMerge: "suggest",
  staleDays: 60,
  usageRanking: true,
};

export const MEMORY_TYPES = [
  "decision",
  "bugfix",
  "pattern",
  "config",
  "discovery",
  "preference",
  "gotcha",
  "summary",
  "note",
] as const;

export const ProjectRefSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  rootPath: z.string().nullable(),
  paseoProjectId: z.string().nullable(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const SearchScopeSchema = z.enum(["all", "project", "global"]);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

const MemoryScope = z.enum(["global", "project"]);

export const serviceInputs = {
  status: z.object({}),
  configure: RuntimeConfigSchema,
  "agent-context": z.object({
    project: ProjectRefSchema.nullable(),
    provider: z.string(),
    includeContext: z.boolean(),
    includeTools: z.boolean(),
    task: z
      .object({ query: z.string().min(1), source: z.enum(TASK_SOURCES) })
      .nullable()
      .default(null),
    taskBudgetMs: z.number().int().min(0).default(0),
  }),
  "link-agent": z.object({
    nonce: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().nullable(),
    title: z.string().nullable(),
  }),
  "project-upsert": z.object({ project: ProjectRefSchema }),
  "record-turn": z.object({
    agentId: z.string().min(1),
    project: ProjectRefSchema.nullable(),
    provider: z.string().nullable(),
    title: z.string().nullable(),
    workspaceDir: z.string().nullable(),
    userText: z.string().nullable(),
    assistantText: z.string().nullable(),
    files: z.array(z.string()),
  }),
  "end-session": z.object({ agentId: z.string().min(1) }),
  "project-known": z.object({ paseoProjectId: z.string() }),
  search: z.object({
    query: z.string(),
    paseoProjectId: z.string().nullable(),
    scope: SearchScopeSchema,
    limit: z.number().int().min(1).max(50),
  }),
  "review-start": z.object({ agentId: z.string().min(1), trigger: z.enum(REVIEW_TRIGGERS) }),
  "review-end": z.object({
    agentId: z.string().min(1),
    reply: z.string().nullable(),
    failed: z.boolean(),
  }),
  "review-skip": z.object({
    agentId: z.string().min(1),
    trigger: z.enum(REVIEW_TRIGGERS),
    reason: z.string().min(1),
  }),
  "upkeep-list": z.object({ paseoProjectId: z.string().nullable() }),
  "upkeep-run": z.object({}),
  keep: z.object({ id: z.number().int() }),
  archive: z.object({ id: z.number().int() }),
  "dismiss-pair": z.object({ a: z.number().int(), b: z.number().int() }),
  save: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    type: z.string(),
    scope: MemoryScope,
    paseoProjectId: z.string().nullable(),
    project: ProjectRefSchema.nullable(),
    pinned: z.boolean(),
  }),
  update: z.object({
    id: z.number().int(),
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    type: z.string().optional(),
    pinned: z.boolean().optional(),
    scope: MemoryScope.optional(),
    paseoProjectId: z.string().nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
  }),
  delete: z.object({ id: z.number().int() }),
  detail: z.object({ id: z.number().int() }),
  restore: z.object({ id: z.number().int(), version: z.number().int() }),
  merge: z.object({ sourceId: z.number().int(), targetId: z.number().int() }),
  sessions: z.object({
    query: z.string(),
    paseoProjectId: z.string().nullable(),
    limit: z.number().int().min(1).max(50),
  }),
  "agent-audit": z.object({ agentId: z.string().min(1) }),
  "workspace-agents": z.object({ workspaceId: z.string().min(1), limit: z.number().int().min(1).max(50) }),
  attachments: z.object({ query: z.string() }),
} as const;

export type ServiceRoute = keyof typeof serviceInputs;
export type ServiceInput<R extends ServiceRoute> = z.input<(typeof serviceInputs)[R]>;
export type ServiceParsedInput<R extends ServiceRoute> = z.output<(typeof serviceInputs)[R]>;

export const MemoryItemSchema = z.object({
  kind: z.enum(["memory", "session"]),
  id: z.string(),
  title: z.string(),
  type: z.string(),
  scope: MemoryScope,
  projectName: z.string().nullable(),
  preview: z.string(),
  pinned: z.boolean(),
  updatedAt: z.string(),
  useCount: z.number(),
  lastUsedAt: z.string().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const MemoryDetailSchema = z.object({
  memory: z
    .object({
      id: z.number(),
      title: z.string(),
      content: z.string(),
      type: z.string(),
      scope: MemoryScope,
      projectName: z.string().nullable(),
      topicKey: z.string().nullable(),
      pinned: z.boolean(),
      source: z.string(),
      agentId: z.string().nullable(),
      provider: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      useCount: z.number(),
      shownCount: z.number(),
      openedCount: z.number(),
      lastUsedAt: z.string().nullable(),
      revisionCount: z.number(),
    })
    .nullable(),
  mergedInto: z.number().nullable(),
  archived: z.boolean(),
  versions: z.array(
    z.object({ version: z.number(), title: z.string(), content: z.string(), createdAt: z.string() }),
  ),
  duplicates: z.array(z.object({ id: z.number(), title: z.string(), similarity: z.number() })),
});
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;

export const SessionItemSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  turns: z.number(),
  lastPrompt: z.string().nullable(),
  lastReply: z.string().nullable(),
  files: z.array(z.string()),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  summary: z.string().nullable(),
  outcomes: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const AUDIT_KINDS = [
  "inject",
  "context",
  "search",
  "get",
  "save",
  "update",
  "delete",
  "review",
  "merge",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

// The title is read at view time; null means the memory was deleted.
const AuditMemorySchema = z.object({
  id: z.number(),
  title: z.string().nullable(),
  score: z.number().nullable(),
  status: z.string().nullable(),
});
const AuditSessionSchema = z.object({ id: z.string(), title: z.string().nullable() });

export const AuditEventSchema = z.object({
  id: z.number(),
  kind: z.enum(AUDIT_KINDS),
  at: z.string(),
  query: z.string().nullable(),
  summary: z.string(),
  text: z.string().nullable(),
  memories: z.array(AuditMemorySchema),
  sessions: z.array(AuditSessionSchema),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AgentAuditSchema = z.object({
  agentId: z.string(),
  linked: z.boolean(),
  provider: z.string().nullable(),
  title: z.string().nullable(),
  projectName: z.string().nullable(),
  createdAt: z.string().nullable(),
  injected: z
    .object({
      memories: z.array(AuditMemorySchema),
      sessions: z.array(AuditSessionSchema),
      chars: z.number(),
      budget: z.number(),
      task: z
        .object({
          query: z.string(),
          source: z.enum(TASK_SOURCES),
          memories: z.array(AuditMemorySchema),
          note: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  events: z.array(AuditEventSchema),
});
export type AgentAudit = z.infer<typeof AgentAuditSchema>;

const PairMemorySchema = z.object({
  id: z.number(),
  title: z.string(),
  type: z.string(),
  scope: MemoryScope,
  preview: z.string(),
  updatedAt: z.string(),
  useCount: z.number(),
});

export const UpkeepListSchema = z.object({
  mode: z.enum(MERGE_MODES),
  staleDays: z.number(),
  lastRunAt: z.string().nullable(),
  duplicates: z.array(
    z.object({
      a: PairMemorySchema,
      b: PairMemorySchema,
      similarity: z.number().nullable(),
      sameTopic: z.boolean(),
      targetId: z.number(),
    }),
  ),
  contradictions: z.array(
    z.object({
      a: PairMemorySchema,
      b: PairMemorySchema,
      similarity: z.number().nullable(),
      sameTopic: z.boolean(),
      values: z.object({ a: z.array(z.string()), b: z.array(z.string()) }),
    }),
  ),
  stale: z.array(MemoryItemSchema),
});
export type UpkeepList = z.infer<typeof UpkeepListSchema>;

export const WorkspaceAgentSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  createdAt: z.string(),
  lastEventAt: z.string().nullable(),
  events: z.number(),
});
export type WorkspaceAgent = z.infer<typeof WorkspaceAgentSchema>;

export interface EmbedderStatus {
  tier: EmbeddingTier;
  model: string;
  dims: number;
  state: "loading" | "ready" | "error";
  error: string | null;
  pending: number;
}

export interface RerankerStatus {
  mode: RerankMode;
  enabled: boolean;
  model: string;
  state: "off" | "loading" | "ready" | "error";
  error: string | null;
}

export interface ServiceStatus {
  pid: number;
  version: string;
  bunVersion: string;
  sqliteVersion: string;
  sqliteLibrary: string | null;
  sqliteVecVersion: string;
  dbPath: string;
  mcpUrl: string;
  memories: number;
  sessions: number;
  projects: number;
  embedder: EmbedderStatus;
  reranker: RerankerStatus;
}

export type SaveStatus =
  | "created"
  | "updated"
  | "duplicate"
  | "near_duplicate"
  | "possible_duplicate"
  | "error";

export interface ServiceOutputs {
  status: ServiceStatus;
  configure: { ok: true };
  "agent-context": {
    systemPrompt: string | null;
    mcpServer: { url: string; headers: Record<string, string> } | null;
    nonce: string | null;
  };
  "link-agent": { ok: boolean };
  "project-upsert": { ok: true };
  "record-turn": { ok: true; recorded: boolean };
  "end-session": { ok: true };
  "project-known": { known: boolean };
  search: { items: MemoryItem[] };
  save: { id: number | null; status: SaveStatus; message: string };
  update: { ok: boolean; message: string };
  delete: { ok: boolean };
  detail: MemoryDetail;
  restore: { ok: boolean };
  merge: { ok: boolean; message: string };
  sessions: { items: SessionItem[] };
  "review-start": { ok: boolean; reason: string | null; cap: number };
  "review-end": { ok: boolean; saved: number[]; updated: number[]; summary: string | null };
  "review-skip": { ok: true };
  "upkeep-list": UpkeepList;
  "upkeep-run": { merged: number; duplicates: number; contradictions: number; stale: number };
  keep: { ok: boolean };
  archive: { ok: boolean };
  "dismiss-pair": { ok: true };
  "agent-audit": AgentAudit;
  "workspace-agents": { agents: WorkspaceAgent[] };
  attachments: {
    items: {
      id: string;
      identifier: string;
      title: string;
      subtitle?: string;
      url: string;
      text: string;
      resourceType: string;
    }[];
  };
}

export type ServiceEvent =
  | { event: "ready"; port: number; status: ServiceStatus }
  | { event: "fatal"; error: string };
