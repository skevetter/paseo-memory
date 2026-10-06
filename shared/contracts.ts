import { defineAttachmentSource, defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "paseo-memory";

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

export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export const MemoryScopeSchema = z.enum(["global", "project"]);
export const SearchScopeSchema = z.enum(["all", "project", "global"]);

export const memorySettings = defineSettings({
  id: "memory",
  scope: "host",
  version: 1,
  schema: z.object({
    injectContext: z.boolean().default(true),
    injectMcp: z.boolean().default(true),
    autoCapture: z.boolean().default(true),
    embeddings: z.enum(["model2vec", "off"]).default("model2vec"),
    mcpPort: z.number().int().min(1024).max(65535).default(6797),
    contextBudgetChars: z.number().int().min(500).max(20000).default(6000),
    sessionRetentionDays: z.number().int().min(1).max(365).default(30),
    duplicateThreshold: z.number().min(0.5).max(1).default(0.92),
    mcpDenyProviders: z.array(z.string()).default(["pi"]),
    sqliteVecPath: z.string().default(""),
  }),
});

export type MemorySettings = z.output<typeof memorySettings.schema>;

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

export const statusRpc = defineRpc({
  name: "memory.status",
  input: z.object({}),
  output: z.object({
    dbPath: z.string(),
    memories: z.number(),
    sessions: z.number(),
    projects: z.number(),
    embeddings: z.string(),
    vectorIndex: z.string(),
    mcp: z.string(),
  }),
});

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
