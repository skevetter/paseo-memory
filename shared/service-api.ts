// Internal HTTP API between the plugin process (supervisor and proxy) and the Bun memory service.
// Every route is POST /v1/<name> with a JSON body on 127.0.0.1, authenticated by the
// SERVICE_KEY_HEADER header. Both sides derive the key from the shared secret file.

import { z } from "zod";

export const SERVICE_KEY_HEADER = "x-paseo-memory-key";
export const SERVICE_KEY_LABEL = "paseo-memory/internal-api/v1";
export const SERVICE_EVENT_PREFIX = "@@paseo-memory ";
export const FATAL_EXIT_CODE = 78;

export const EMBEDDING_TIERS = ["zero", "low", "medium", "high"] as const;
export type EmbeddingTier = (typeof EMBEDDING_TIERS)[number];

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

export const serviceInputs = {
  status: z.object({}),
  "agent-context": z.object({
    project: ProjectRefSchema.nullable(),
    provider: z.string(),
    includeContext: z.boolean(),
    includeTools: z.boolean(),
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
  save: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    type: z.string(),
    scope: z.enum(["global", "project"]),
    paseoProjectId: z.string().nullable(),
    project: ProjectRefSchema.nullable(),
    pinned: z.boolean(),
  }),
  update: z.object({ id: z.number().int(), pinned: z.boolean().optional() }),
  delete: z.object({ id: z.number().int() }),
  attachments: z.object({ query: z.string() }),
} as const;

export type ServiceRoute = keyof typeof serviceInputs;
export type ServiceInput<R extends ServiceRoute> = z.input<(typeof serviceInputs)[R]>;
export type ServiceParsedInput<R extends ServiceRoute> = z.output<(typeof serviceInputs)[R]>;

export interface MemoryItem {
  kind: "memory" | "session";
  id: string;
  title: string;
  type: string;
  scope: "global" | "project";
  projectName: string | null;
  preview: string;
  pinned: boolean;
  updatedAt: string;
}

export interface EmbedderStatus {
  tier: EmbeddingTier;
  model: string;
  dims: number;
  state: "loading" | "ready" | "error";
  error: string | null;
  pending: number;
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
}

export interface ServiceOutputs {
  status: ServiceStatus;
  "agent-context": {
    systemPrompt: string | null;
    mcpServer: { url: string; headers: Record<string, string> } | null;
  };
  "project-upsert": { ok: true };
  "record-turn": { ok: true };
  "end-session": { ok: true };
  "project-known": { known: boolean };
  search: { items: MemoryItem[] };
  save: { id: number | null; status: string; message: string };
  update: { ok: boolean };
  delete: { ok: boolean };
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

// One JSON line on the service's stdout, prefixed with SERVICE_EVENT_PREFIX, reports startup.
export type ServiceEvent =
  | { event: "ready"; port: number; status: ServiceStatus }
  | { event: "fatal"; error: string };
