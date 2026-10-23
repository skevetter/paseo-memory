import { z } from "zod";
import { MAX_CONTENT_CHARS, MEMORY_TYPES } from "../shared/service-api";
import { Access } from "./access";
import { buildContext } from "./context";
import { type Caller, type ToolDefinition, ToolError } from "./mcp";
import type { ReviewWindows } from "./review";
import {
  ContentTooLongError,
  type MemoryStore,
  type ProjectRef,
  type SaveInput,
  type SaveResult,
  type SearchHit,
} from "./store";
import { age } from "./text";

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
  windows: ReviewWindows;
  resolveProject(caller: Caller): ProjectRef | null;
}

const MAX_TITLE_CHARS = 200;
const MAX_QUERY_CHARS = 1000;
const MAX_TOPIC_CHARS = 200;
// Bounds the request; the real content limit is enforced by the store with a message the model can act on.
const MAX_CONTENT_INPUT_CHARS = MAX_CONTENT_CHARS * 25;

const memoryType = z.enum(MEMORY_TYPES);
const memoryId = z.number().int().positive();
const title = z.string().trim().min(1).max(MAX_TITLE_CHARS);
const topicKey = z.string().trim().min(1).max(MAX_TOPIC_CHARS);
const content = z.string().trim().min(1).max(MAX_CONTENT_INPUT_CHARS);

const searchInput = z.strictObject({
  query: z.string().max(MAX_QUERY_CHARS).describe("What to look for."),
  scope: z.enum(["all", "project", "global"]).optional(),
  type: memoryType.optional(),
  limit: z.number().int().min(1).max(25).optional(),
  include_sessions: z.boolean().optional().describe("Also search recent agent session digests."),
});

const getInput = z.strictObject({ ids: z.array(memoryId).min(1).max(20) });

const saveInput = z.strictObject({
  title: title.describe("Short, searchable title."),
  content: content.describe("What / Why / Where / Learned, under 800 characters."),
  type: memoryType.optional(),
  scope: z.enum(["project", "global"]).optional(),
  topic_key: topicKey.optional().describe("Stable key, e.g. 'auth/token-refresh'."),
  pinned: z.boolean().optional().describe("Pinned memories are injected into every new agent."),
  force: z.boolean().optional().describe("Save even when a similar memory exists."),
});

const updateInput = z
  .strictObject({
    id: memoryId,
    title: title.optional(),
    content: content.optional(),
    type: memoryType.optional(),
    pinned: z.boolean().optional(),
    topic_key: topicKey.optional(),
  })
  .refine((input) => Object.keys(input).some((key) => key !== "id"), {
    message: "provide at least one field to change besides id",
  });

const deleteInput = z.strictObject({ id: memoryId });
const contextInput = z.strictObject({});

interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, caller: Caller, access: Access): Promise<string> | string;
}

// Arguments are parsed before any handler logic runs, so a malformed call can never reach the store.
function defineTool<S extends z.ZodType>(ctx: ToolContext, spec: ToolSpec<S>): ToolDefinition {
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(spec.schema, { io: "input" });
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    async handler(raw, caller) {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        ctx.store.audit.record(caller.nonce, {
          kind: "invalid",
          tool: spec.name,
          fields: parsed.error.issues.flatMap(issueFields),
        });
        throw new ToolError("invalid_input", describeIssues(parsed.error));
      }
      try {
        return await spec.run(parsed.data, caller, Access.agent(caller.projectKey));
      } catch (error) {
        if (error instanceof ContentTooLongError) throw new ToolError("content_too_long", error.message);
        throw error;
      }
    },
  };
}

function issueFields(issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") return issue.keys;
  return [issue.path.join(".") || "arguments"];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function recordDenied(
  ctx: ToolContext,
  caller: Caller,
  denial: { tool: string; operation: string; ids: number[] },
): void {
  if (denial.ids.length === 0) return;
  ctx.store.audit.record(caller.nonce, { kind: "denied", ...denial });
}

export function createTools(ctx: ToolContext): ToolDefinition[] {
  return [searchTool(ctx), getTool(ctx), saveTool(ctx), updateTool(ctx), deleteTool(ctx), contextTool(ctx)];
}

function searchTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_search",
    description:
      "Search durable memory by meaning and keywords. Returns compact hits; call memory_get for full content. " +
      "scope: all (project + global, default), project, or global. Search before saving to avoid duplicates.",
    schema: searchInput,
    async run(args, caller, access) {
      const scope = args.scope ?? "all";
      const hits = await ctx.store.search({
        query: args.query,
        access,
        scope,
        type: args.type,
        limit: args.limit ?? 8,
        includeSessions: args.include_sessions === true,
        track: true,
      });
      ctx.store.audit.record(caller.nonce, {
        kind: "search",
        query: args.query,
        scope,
        results: hits.map((h) => ({
          id: h.kind === "session" ? `session:${h.id}` : h.id,
          score: Math.round(h.score * 10_000) / 10_000,
        })),
      });
      return hits.length === 0 ? "No matching memories." : hits.map(formatHit).join("\n");
    },
  });
}

function formatHit(h: SearchHit): string {
  if (h.kind === "session")
    return `session:${h.id} [session] ${h.title} (${age(h.updatedAt)})\n  ${h.preview}`;
  return `#${h.id} [${h.type}/${h.scope}${h.pinned ? "/pinned" : ""}] ${h.title} (${age(h.updatedAt)})\n  ${h.preview}`;
}

function getTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_get",
    description: "Get full content for memory ids returned by memory_search.",
    schema: getInput,
    run({ ids }, caller, access) {
      const rows = ctx.store.getVisible(access, ids);
      recordDenied(ctx, caller, {
        tool: "memory_get",
        operation: "read",
        ids: ctx.store.deniedIds(access, ids),
      });
      ctx.store.markUsed(rows.map((r) => r.id));
      const shown = caller.nonce ? ctx.store.audit.shownTo(caller.nonce) : new Set<number>();
      ctx.store.markOpened(rows.map((r) => r.id).filter((id) => shown.has(id)));
      ctx.store.audit.record(caller.nonce, { kind: "get", ids, found: rows.map((r) => r.id) });
      const found = new Set(rows.map((r) => r.id));
      const merged = ids.flatMap((id) => {
        const target = found.has(id) ? null : ctx.store.mergedIntoVisible(access, id);
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
  });
}

function saveTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_save",
    description:
      "Save one durable fact: a decision, root cause, convention, config detail, or user correction. Search " +
      "first. Keep content under 800 characters; content over " +
      `${MAX_CONTENT_CHARS} characters is rejected. Default scope is project (shared across this project's ` +
      "worktrees); use global for user preferences that apply to every project. Provide topic_key to update an " +
      "existing entry for the same topic. A near-identical memory of the same type is not saved again: the " +
      "result names it so you can call memory_update instead.",
    schema: saveInput,
    async run(args, caller) {
      const project = ctx.resolveProject(caller);
      const scope = args.scope === "global" ? "global" : "project";
      if (scope === "project" && !project) {
        return "This agent is not attached to a Paseo project, so project memory is unavailable. Use scope=global or skip.";
      }
      ctx.windows.checkSave(caller.nonce);
      const result = await ctx.store.save(toSaveInput(args, { scope, project, caller }));
      ctx.windows.countSave(caller.nonce, result.status);
      const candidates = result.status === "possible_duplicate" ? result.candidates.map((c) => c.id) : [];
      ctx.store.audit.record(caller.nonce, {
        kind: "save",
        id: result.id,
        status: result.status,
        candidates,
      });
      return formatSave(result, scope === "project" ? project : null);
    },
  });
}

function toSaveInput(
  args: z.output<typeof saveInput>,
  input: { scope: "global" | "project"; project: ProjectRef | null; caller: Caller },
): SaveInput {
  return {
    title: args.title,
    content: args.content,
    type: args.type ?? "note",
    scope: input.scope,
    project: input.project,
    topicKey: args.topic_key ?? null,
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
  return defineTool(ctx, {
    name: "memory_update",
    description:
      "Update a memory by id (title, content, type, pinned, topic_key). Prior text is kept as a version. " +
      `Content over ${MAX_CONTENT_CHARS} characters is rejected.`,
    schema: updateInput,
    run(args, caller, access) {
      const { id } = args;
      const outcome = ctx.store.updateAuthorized(access, id, {
        title: args.title,
        content: args.content,
        type: args.type,
        pinned: args.pinned,
        topicKey: args.topic_key,
      });
      if (outcome === "denied")
        recordDenied(ctx, caller, { tool: "memory_update", operation: "write", ids: [id] });
      else ctx.store.audit.record(caller.nonce, { kind: "update", id, ok: outcome === "ok" });
      return outcome === "ok" ? `updated: #${id}` : `not found: #${id}`;
    },
  });
}

function deleteTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_delete",
    description: "Delete a memory that is wrong or obsolete (soft delete).",
    schema: deleteInput,
    run({ id }, caller, access) {
      const outcome = ctx.store.deleteAuthorized(access, id);
      if (outcome === "denied")
        recordDenied(ctx, caller, { tool: "memory_delete", operation: "delete", ids: [id] });
      else ctx.store.audit.record(caller.nonce, { kind: "delete", id, ok: outcome === "ok" });
      return outcome === "ok" ? `deleted: #${id}` : `not found: #${id}`;
    },
  });
}

function contextTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_context",
    description:
      "Return the memory digest for this project: pinned global and project memories, the project's most " +
      "used and recent memories, and recent agent sessions. Use after context compaction or when starting " +
      "unfamiliar work.",
    schema: contextInput,
    run(_args, caller) {
      const context = buildContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        excludeAgentId: caller.agentId,
      });
      ctx.store.markShown(context.memoryIds);
      ctx.store.audit.record(caller.nonce, {
        kind: "context",
        memories: context.memoryIds,
        sessions: context.sessionIds,
        chars: context.text.length,
        budget: ctx.store.config.contextBudgetChars,
      });
      return context.text;
    },
  });
}
