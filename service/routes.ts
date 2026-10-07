import { randomBytes } from "node:crypto";
import type {
  MemoryItem,
  ProjectRef,
  ServiceOutputs,
  ServiceParsedInput,
  ServiceRoute,
  ServiceStatus,
  SessionItem,
} from "../shared/service-api";
import { buildContext, buildSystemPrompt } from "./context";
import { signCaller } from "./mcp";
import { errorText } from "./sqlite";
import type { MemoryStore, SearchHit, SessionRow } from "./store";

export interface RouteContext {
  store: MemoryStore;
  secret: string;
  mcpUrl(): string;
  contextBudget: number;
  status(): ServiceStatus;
}

export type Routes = {
  [R in ServiceRoute]: (input: ServiceParsedInput<R>) => Promise<ServiceOutputs[R]> | ServiceOutputs[R];
};

export function createRoutes(ctx: RouteContext): Routes {
  const { store } = ctx;
  const projectOf = (paseoProjectId: string | null) =>
    paseoProjectId ? store.projectByPaseoId(paseoProjectId) : null;
  return {
    status: () => ctx.status(),
    "agent-context": (input) => agentContext(ctx, input),
    "link-agent": (input) => {
      store.audit.link(input);
      return { ok: true };
    },
    "project-upsert": (input) => {
      store.upsertProject(input.project);
      return { ok: true };
    },
    "record-turn": (input) => ({ ok: true, recorded: store.recordTurn(input) }),
    "end-session": (input) => {
      store.endSession(input.agentId);
      return { ok: true };
    },
    "project-known": (input) => ({ known: store.projectByPaseoId(input.paseoProjectId) !== null }),
    search: async (input) => {
      const project = projectOf(input.paseoProjectId);
      const hits = input.stale
        ? store.list({ project, scope: input.scope, limit: input.limit, stale: true })
        : await store.search({ query: input.query, project, scope: input.scope, limit: input.limit });
      return { items: hits.map(toItem) };
    },
    save: (input) => saveFromUi(store, input),
    update: (input) => updateFromUi(store, input),
    delete: (input) => ({ ok: store.delete(input.id) }),
    detail: (input) => store.detail(input.id),
    restore: (input) => ({ ok: store.restore(input.id, input.version) }),
    merge: (input) => store.merge(input.sourceId, input.targetId),
    sessions: (input) => {
      const projectKey = projectOf(input.paseoProjectId)?.key ?? null;
      return { items: store.sessions({ projectKey, query: input.query, limit: input.limit }).map(toSession) };
    },
    "agent-audit": (input) => store.audit.agent(input.agentId),
    "workspace-agents": (input) => ({ agents: store.audit.workspaceAgents(input.workspaceId, input.limit) }),
    attachments: (input) => attachments(store, input.query),
  };
}

function agentContext(
  ctx: RouteContext,
  input: ServiceParsedInput<"agent-context">,
): ServiceOutputs["agent-context"] {
  const { project, provider } = input;
  const { store } = ctx;
  if (project) store.upsertProject(project);
  const nonce = randomBytes(12).toString("base64url");
  store.audit.open({ nonce, projectKey: project?.key ?? null, provider });
  let systemPrompt: string | null = null;
  if (input.includeContext) {
    const context = buildContext({ store, project, budgetChars: ctx.contextBudget });
    systemPrompt = buildSystemPrompt({ context: context.text, project, hasTools: input.includeTools });
    store.markUsed(context.memoryIds);
    store.audit.record(nonce, {
      kind: "inject",
      memories: context.memoryIds,
      sessions: context.sessionIds,
      chars: systemPrompt.length,
      budget: ctx.contextBudget,
    });
  }
  const caller = { projectKey: project?.key ?? null, agentId: null, provider, nonce };
  const mcpServer = input.includeTools
    ? { url: ctx.mcpUrl(), headers: signCaller(ctx.secret, caller) }
    : null;
  return { systemPrompt, mcpServer, nonce };
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

function updateFromUi(store: MemoryStore, input: ServiceParsedInput<"update">): ServiceOutputs["update"] {
  const known = input.paseoProjectId ? store.projectByPaseoId(input.paseoProjectId) : null;
  try {
    const ok = store.update(input.id, {
      title: input.title,
      content: input.content,
      type: input.type,
      pinned: input.pinned,
      scope: input.scope,
      project: known ?? input.project ?? null,
    });
    return { ok, message: ok ? "Saved." : "This memory no longer exists." };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
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
    useCount: h.kind === "memory" ? h.useCount : 0,
    lastUsedAt: h.kind === "memory" ? h.lastUsedAt : null,
  };
}

function toSession(s: SessionRow): SessionItem {
  return {
    agentId: s.agent_id,
    title: s.title,
    provider: s.provider,
    turns: s.turns,
    lastPrompt: s.last_prompt,
    lastReply: s.last_reply,
    files: JSON.parse(s.files) as string[],
    updatedAt: s.updated_at,
    endedAt: s.ended_at,
  };
}
