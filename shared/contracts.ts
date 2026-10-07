import { defineAttachmentSource, defineRpc, defineSettings, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { EMBEDDING_TIERS, MEMORY_TYPES, SearchScopeSchema } from "./service-api";

export const PLUGIN_ID = "paseo-memory";

export { MEMORY_TYPES, SearchScopeSchema };
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export const MemoryScopeSchema = z.enum(["global", "project"]);

const settingsSchema = z.object({
  injectContext: z.boolean().default(true),
  injectMcp: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  embeddingTier: z.enum(EMBEDDING_TIERS).default("medium"),
  mcpPort: z.number().int().min(1024).max(65535).default(6797),
  contextBudgetChars: z.number().int().min(500).max(20000).default(6000),
  sessionRetentionDays: z.number().int().min(1).max(365).default(30),
  mcpDenyProviders: z.array(z.string()).default(["pi"]),
  // Empty means auto-detect: bun on PATH, Homebrew SQLite, and the plugin directory from config.json.
  bunPath: z.string().default(""),
  sqlitePath: z.string().default(""),
  servicePath: z.string().default(""),
});

export const memorySettings = defineSettings({
  id: "memory",
  scope: "host",
  version: 2,
  schema: settingsSchema,
  // v1 had embeddings (model2vec | off), duplicateThreshold and sqliteVecPath. v2 replaces them
  // with embeddingTier (per-tier thresholds) and a required sqlite-vec.
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

export const MemoryItemSchema = z.object({
  kind: z.enum(["memory", "session"]),
  id: z.string(),
  title: z.string(),
  type: z.string(),
  scope: MemoryScopeSchema,
  projectName: z.string().nullable(),
  preview: z.string(),
  pinned: z.boolean(),
  updatedAt: z.string(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

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

export const saveMemoryRpc = defineRpc({
  name: "memory.save",
  input: z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(20000),
    type: MemoryTypeSchema.default("note"),
    scope: MemoryScopeSchema.default("project"),
    paseoProjectId: z.string().nullable(),
    pinned: z.boolean().default(false),
  }),
  output: z.object({ id: z.number().nullable(), status: z.string(), message: z.string() }),
});

export const updateMemoryRpc = defineRpc({
  name: "memory.update",
  input: z.object({ id: z.number().int(), pinned: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
});

export const deleteMemoryRpc = defineRpc({
  name: "memory.delete",
  input: z.object({ id: z.number().int() }),
  output: z.object({ ok: z.boolean() }),
});

export const ServiceStateSchema = z.enum(["starting", "running", "restarting", "fatal", "stopped"]);

export const statusRpc = defineRpc({
  name: "memory.status",
  input: z.object({}),
  output: z.object({
    service: z.object({
      state: ServiceStateSchema,
      // Human-readable cause for fatal and restarting states (missing bun, sqlite-vec failure, ...).
      detail: z.string().nullable(),
      bunPath: z.string().nullable(),
      bunVersion: z.string().nullable(),
      servicePath: z.string().nullable(),
      servicePathSource: z.string().nullable(),
      pid: z.number().nullable(),
      restarts: z.number(),
    }),
    // Null until the service reports ready.
    live: z
      .object({
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
