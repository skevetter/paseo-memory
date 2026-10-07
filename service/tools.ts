// MCP tool surface exposed to agents. Tool names, schemas and result text match v0.1.

import { MEMORY_TYPES } from "../shared/service-api";
import { buildContext } from "./context";
import type { Caller, ToolDefinition } from "./mcp";
import type { MemoryStore, ProjectRef, SaveResult, SearchHit, SearchScope } from "./store";
import { age } from "./text";

const TYPES: readonly string[] = MEMORY_TYPES;

export const MCP_INSTRUCTIONS = [
  "paseo-memory: durable memory shared by every Paseo agent on this host.",
  "Global memory applies everywhere; project memory is shared by all worktrees of the same project.",
  "Search (memory_search) before re-deriving past decisions or when the user says 'remember' or 'last time'.",
  "Save (memory_save) right after a decision, root cause, config change, convention, or user correction.",
  "Write content as What / Why / Where / Learned. Use topic_key for a topic that evolves so saves update one entry.",
  "Never save secrets, credentials, raw transcripts, or customer data.",
].join("\n");

export interface ToolContext {
  store: MemoryStore;
  resolveProject(caller: Caller): ProjectRef | null;
  contextBudget(): number;
}

export function createTools(ctx: ToolContext): ToolDefinition[] {
  return [searchTool(ctx), getTool(ctx), saveTool(ctx), updateTool(ctx), deleteTool(ctx), contextTool(ctx)];
}

function searchTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_search",
    description:
      "Search durable memory (keyword + semantic). Returns compact hits; call memory_get for full content. " +
      "scope: all (project + global, default), project, or global.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        scope: { type: "string", enum: ["all", "project", "global"] },
        type: { type: "string", enum: TYPES },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        include_sessions: { type: "boolean", description: "Also search recent agent session digests." },
      },
      required: ["query"],
    },
    async handler(args, caller) {
      const scope = str(args.scope);
      const hits = await ctx.store.search({
        query: str(args.query),
        project: ctx.resolveProject(caller),
        scope: scope === "project" || scope === "global" ? scope : ("all" satisfies SearchScope),
        type: str(args.type) || undefined,
        limit: num(args.limit, 8),
        includeSessions: args.include_sessions === true,
      });
      return hits.length === 0 ? "No matching memories." : hits.map(formatHit).join("\n");
    },
  };
}

function formatHit(h: SearchHit): string {
  if (h.kind === "session")
    return `session:${h.id} [session] ${h.title} (${age(h.updatedAt)})\n  ${h.preview}`;
  return `#${h.id} [${h.type}/${h.scope}${h.pinned ? "/pinned" : ""}] ${h.title} (${age(h.updatedAt)})\n  ${h.preview}`;
}

function getTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_get",
    description: "Get full content for memory ids returned by memory_search.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "integer" }, maxItems: 20 } },
      required: ["ids"],
    },
    handler(args) {
      const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isInteger) : [];
      const rows = ctx.store.get(ids);
      if (rows.length === 0) return "No memories found for those ids.";
      return rows
        .map(
          (r) =>
            `#${r.id} [${r.type}/${r.scope}${r.pinned ? "/pinned" : ""}] ${r.title}\n` +
            `project: ${r.project_name ?? "(global)"}  topic_key: ${r.topic_key ?? "-"}  updated: ${r.updated_at}  revisions: ${r.revision_count}\n\n${r.content}`,
        )
        .join("\n\n---\n\n");
    },
  };
}

function saveTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_save",
    description:
      "Save a durable memory. Default scope is project (shared across this project's worktrees); use global " +
      "for user preferences and conventions that apply to every project. Provide topic_key to update an " +
      "existing entry for the same topic. Returns possible_duplicate with candidates when a near-identical " +
      "memory exists: update that one, pass its topic_key, or retry with force=true.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, searchable title." },
        content: { type: "string", description: "What / Why / Where / Learned." },
        type: { type: "string", enum: TYPES },
        scope: { type: "string", enum: ["project", "global"] },
        topic_key: { type: "string", description: "Stable key, e.g. 'auth/token-refresh'." },
        pinned: { type: "boolean", description: "Pinned memories are injected into every new agent." },
        force: { type: "boolean" },
      },
      required: ["title", "content"],
    },
    async handler(args, caller) {
      const project = ctx.resolveProject(caller);
      const scope = str(args.scope) === "global" ? "global" : "project";
      if (scope === "project" && !project) {
        return "This agent is not attached to a Paseo project, so project memory is unavailable. Use scope=global or skip.";
      }
      const result = await ctx.store.save({
        title: str(args.title),
        content: str(args.content),
        type: TYPES.includes(str(args.type)) ? str(args.type) : "note",
        scope,
        project,
        topicKey: str(args.topic_key) || null,
        pinned: args.pinned === true,
        force: args.force === true,
        source: "agent",
        agentId: caller.agentId,
        provider: caller.provider,
      });
      return formatSave(result, scope === "project" ? project : null);
    },
  };
}

function formatSave(result: SaveResult, project: ProjectRef | null): string {
  if (result.status === "possible_duplicate") {
    const candidates = result.candidates
      .map((c) => `#${c.id} ${c.title} (similarity ${c.similarity})`)
      .join("\n");
    return `possible_duplicate: not saved. Similar memories:\n${candidates}\nUpdate one with memory_update, or retry with force=true.`;
  }
  return `${result.status}: #${result.id} (${project ? `project: ${project.name}` : "global"})`;
}

function updateTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_update",
    description:
      "Update a memory by id (title, content, type, pinned, topic_key). Prior text is kept as a version.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: TYPES },
        pinned: { type: "boolean" },
        topic_key: { type: "string" },
      },
      required: ["id"],
    },
    handler(args) {
      const ok = ctx.store.update(num(args.id, -1), {
        title: optStr(args.title),
        content: optStr(args.content),
        type: optStr(args.type),
        pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
        topicKey: optStr(args.topic_key),
      });
      return ok ? `updated: #${args.id}` : `not found: #${args.id}`;
    },
  };
}

function deleteTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_delete",
    description: "Delete a memory that is wrong or obsolete (soft delete).",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    handler(args) {
      return ctx.store.delete(num(args.id, -1)) ? `deleted: #${args.id}` : `not found: #${args.id}`;
    },
  };
}

function contextTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_context",
    description:
      "Return the memory digest for this project: pinned global and project memories, recent project " +
      "memories, and recent agent sessions. Use after context compaction or when starting unfamiliar work.",
    inputSchema: { type: "object", properties: {} },
    handler(_args, caller) {
      return buildContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        budgetChars: ctx.contextBudget(),
        excludeAgentId: caller.agentId,
      });
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
