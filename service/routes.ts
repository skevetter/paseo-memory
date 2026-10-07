// Internal API routes for the plugin process. Inputs arrive validated by serviceInputs.

import type {
  MemoryItem,
  ProjectRef,
  ServiceOutputs,
  ServiceParsedInput,
  ServiceRoute,
  ServiceStatus,
} from "../shared/service-api";
import { buildContext, buildSystemPrompt } from "./context";
import { signCaller } from "./mcp";
import type { MemoryStore, SearchHit } from "./store";

export interface RouteContext {
  store: MemoryStore;
  secret: string;
  // Known only after the server binds its port.
  mcpUrl(): string;
  contextBudget: number;
  status(): ServiceStatus;
}

export type Routes = {
  [R in ServiceRoute]: (input: ServiceParsedInput<R>) => Promise<ServiceOutputs[R]> | ServiceOutputs[R];
};

export function createRoutes(ctx: RouteContext): Routes {
  const { store } = ctx;
  return {
    status: () => ctx.status(),
    "agent-context": (input) => agentContext(ctx, input),
    "project-upsert": (input) => {
      store.upsertProject(input.project);
      return { ok: true };
    },
    "record-turn": (input) => {
      store.recordTurn(input);
      return { ok: true };
    },
    "end-session": (input) => {
      store.endSession(input.agentId);
      return { ok: true };
    },
    "project-known": (input) => ({ known: store.projectByPaseoId(input.paseoProjectId) !== null }),
    search: async (input) => {
      const project = input.paseoProjectId ? store.projectByPaseoId(input.paseoProjectId) : null;
      const hits = await store.search({
        query: input.query,
        project,
        scope: input.scope,
        limit: input.limit,
      });
      return { items: hits.map(toItem) };
    },
    save: (input) => saveFromUi(store, input),
    update: (input) => ({ ok: store.update(input.id, { pinned: input.pinned }) }),
    delete: (input) => ({ ok: store.delete(input.id) }),
    attachments: (input) => attachments(store, input.query),
  };
}

function agentContext(
  ctx: RouteContext,
  input: ServiceParsedInput<"agent-context">,
): ServiceOutputs["agent-context"] {
  const { project } = input;
  if (project) ctx.store.upsertProject(project);
  const context = input.includeContext
    ? buildContext({ store: ctx.store, project, budgetChars: ctx.contextBudget })
    : null;
  const systemPrompt =
    context === null ? null : buildSystemPrompt({ context, project, hasTools: input.includeTools });
  const caller = { projectKey: project?.key ?? null, agentId: null, provider: input.provider };
  const mcpServer = input.includeTools
    ? { url: ctx.mcpUrl(), headers: signCaller(ctx.secret, caller) }
    : null;
  return { systemPrompt, mcpServer };
}

async function saveFromUi(
  store: MemoryStore,
  input: ServiceParsedInput<"save">,
): Promise<ServiceOutputs["save"]> {
  const known = input.paseoProjectId ? store.projectByPaseoId(input.paseoProjectId) : null;
  const project: ProjectRef | null = known ?? input.project;
  if (input.scope === "project" && !project) return { id: null, status: "error", message: "Unknown project" };
  const result = await store.save({ ...input, project, force: true, source: "user" });
  return { id: result.id, status: result.status, message: `${result.status} #${result.id ?? "-"}` };
}

async function attachments(store: MemoryStore, query: string): Promise<ServiceOutputs["attachments"]> {
  const hits = await store.search({ query, project: null, scope: "all", limit: 15 });
  const items = hits
    .filter((h) => h.kind === "memory")
    .map((h) => {
      const where = h.projectName ?? "global";
      const content = store.get([Number(h.id)])[0]?.content ?? h.preview;
      return {
        id: h.id,
        identifier: `#${h.id}`,
        title: h.title,
        subtitle: `${h.type} · ${where}`,
        url: `https://paseo.sh/memory/${h.id}`,
        text: `Memory #${h.id} (${h.type}, ${where}): ${h.title}\n\n${content}`,
        resourceType: "memory",
      };
    });
  return { items };
}

function toItem(h: SearchHit): MemoryItem {
  return {
    kind: h.kind,
    id: h.id,
    title: h.title,
    type: h.type,
    scope: h.scope,
    projectName: h.projectName,
    preview: h.preview,
    pinned: h.pinned,
    updatedAt: h.updatedAt,
  };
}
