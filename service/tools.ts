import { MAX_CONTENT_CHARS, MEMORY_TYPES } from "../shared/service-api";
import { buildContext } from "./context";
import type { Caller, ToolDefinition } from "./mcp";
import type { MemoryStore, ProjectRef, SaveInput, SaveResult, SearchHit, SearchScope } from "./store";
import { age } from "./text";

const TYPES: readonly string[] = MEMORY_TYPES;

export const MCP_INSTRUCTIONS = [
  "paseo-memory: durable memory shared by every Paseo agent on this host.",
  "Global memory applies everywhere; project memory is shared by all worktrees of the same project.",
  "Search (memory_search) before re-deriving past decisions, when the user says 'remember' or 'last time', and before every save.",
  "Save (memory_save) only durable facts: decisions, root causes, conventions, config, and user corrections.",
  "Do not save task progress, plans, chat summaries, or anything the code or git history already records.",
  "One fact per memory, content under about 800 characters, written as What / Why / Where / Learned.",
  "Use topic_key for a topic that evolves so later saves update one entry; use memory_update to correct a memory.",
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
      "Search durable memory by meaning and keywords. Returns compact hits; call memory_get for full content. " +
      "scope: all (project + global, default), project, or global. Search before saving to avoid duplicates.",
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
      const raw = str(args.scope);
      const scope: SearchScope = raw === "project" || raw === "global" ? raw : "all";
      const query = str(args.query);
      const hits = await ctx.store.search({
        query,
        project: ctx.resolveProject(caller),
        scope,
        type: str(args.type) || undefined,
        limit: num(args.limit, 8),
        includeSessions: args.include_sessions === true,
        track: true,
      });
      ctx.store.audit.record(caller.nonce, {
        kind: "search",
        query,
        scope,
        results: hits.map((h) => ({
          id: h.kind === "session" ? `session:${h.id}` : h.id,
          score: Math.round(h.score * 10_000) / 10_000,
        })),
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
    handler(args, caller) {
      const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isInteger) : [];
      const rows = ctx.store.get(ids);
      ctx.store.markUsed(rows.map((r) => r.id));
      ctx.store.audit.record(caller.nonce, { kind: "get", ids, found: rows.map((r) => r.id) });
      const found = new Set(rows.map((r) => r.id));
      const merged = ids.flatMap((id) => {
        const target = found.has(id) ? null : ctx.store.mergedInto(id);
        return target === null ? [] : [`#${id} was merged into #${target}; fetch #${target} instead.`];
      });
      if (rows.length === 0 && merged.length === 0) return "No memories found for those ids.";
      const bodies = rows.map(
        (r) =>
          `#${r.id} [${r.type}/${r.scope}${r.pinned ? "/pinned" : ""}] ${r.title}\n` +
          `project: ${r.project_name ?? "(global)"}  topic_key: ${r.topic_key ?? "-"}  updated: ${r.updated_at}  revisions: ${r.revision_count}\n\n${r.content}`,
      );
      return [...merged, ...bodies].join("\n\n---\n\n");
    },
  };
}

function saveTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_save",
    description:
      "Save one durable fact: a decision, root cause, convention, config detail, or user correction. Search " +
      "first. Keep content under 800 characters; content over " +
      `${MAX_CONTENT_CHARS} characters is rejected. Default scope is project (shared across this project's ` +
      "worktrees); use global for user preferences that apply to every project. Provide topic_key to update an " +
      "existing entry for the same topic. A near-identical memory of the same type is not saved again: the " +
      "result names it so you can call memory_update instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, searchable title." },
        content: { type: "string", description: "What / Why / Where / Learned, under 800 characters." },
        type: { type: "string", enum: TYPES },
        scope: { type: "string", enum: ["project", "global"] },
        topic_key: { type: "string", description: "Stable key, e.g. 'auth/token-refresh'." },
        pinned: { type: "boolean", description: "Pinned memories are injected into every new agent." },
        force: { type: "boolean", description: "Save even when a similar memory exists." },
      },
      required: ["title", "content"],
    },
    async handler(args, caller) {
      const project = ctx.resolveProject(caller);
      const scope = str(args.scope) === "global" ? "global" : "project";
      if (scope === "project" && !project) {
        return "This agent is not attached to a Paseo project, so project memory is unavailable. Use scope=global or skip.";
      }
      const result = await ctx.store.save(saveInput(args, { scope, project, caller }));
      const candidates = result.status === "possible_duplicate" ? result.candidates.map((c) => c.id) : [];
      ctx.store.audit.record(caller.nonce, {
        kind: "save",
        id: result.id,
        status: result.status,
        candidates,
      });
      return formatSave(result, scope === "project" ? project : null);
    },
  };
}

function saveInput(
  args: Record<string, unknown>,
  input: { scope: "global" | "project"; project: ProjectRef | null; caller: Caller },
): SaveInput {
  const type = str(args.type);
  return {
    title: str(args.title),
    content: str(args.content),
    type: TYPES.includes(type) ? type : "note",
    scope: input.scope,
    project: input.project,
    topicKey: str(args.topic_key) || null,
    pinned: args.pinned === true,
    force: args.force === true,
    source: "agent",
    agentId: input.caller.agentId,
    provider: input.caller.provider,
  };
}

function formatSave(result: SaveResult, project: ProjectRef | null): string {
  if (result.status === "near_duplicate") {
    return (
      `near_duplicate: not saved. #${result.id} "${result.title}" already says this (similarity ${result.similarity}). ` +
      `Call memory_update with id ${result.id} to change it.`
    );
  }
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
      "Update a memory by id (title, content, type, pinned, topic_key). Prior text is kept as a version. " +
      `Content over ${MAX_CONTENT_CHARS} characters is rejected.`,
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
    handler(args, caller) {
      const id = num(args.id, -1);
      const ok = ctx.store.update(id, {
        title: optStr(args.title),
        content: optStr(args.content),
        type: optStr(args.type),
        pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
        topicKey: optStr(args.topic_key),
      });
      ctx.store.audit.record(caller.nonce, { kind: "update", id, ok });
      return ok ? `updated: #${id}` : `not found: #${id}`;
    },
  };
}

function deleteTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_delete",
    description: "Delete a memory that is wrong or obsolete (soft delete).",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    handler(args, caller) {
      const id = num(args.id, -1);
      const ok = ctx.store.delete(id);
      ctx.store.audit.record(caller.nonce, { kind: "delete", id, ok });
      return ok ? `deleted: #${id}` : `not found: #${id}`;
    },
  };
}

function contextTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_context",
    description:
      "Return the memory digest for this project: pinned global and project memories, the project's most " +
      "used and recent memories, and recent agent sessions. Use after context compaction or when starting " +
      "unfamiliar work.",
    inputSchema: { type: "object", properties: {} },
    handler(_args, caller) {
      const budget = ctx.contextBudget();
      const context = buildContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        budgetChars: budget,
        excludeAgentId: caller.agentId,
      });
      ctx.store.markUsed(context.memoryIds);
      ctx.store.audit.record(caller.nonce, {
        kind: "context",
        memories: context.memoryIds,
        sessions: context.sessionIds,
        chars: context.text.length,
        budget,
      });
      return context.text;
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
