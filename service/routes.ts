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
import { redact } from "./redact";
import { finishReview, type ReviewWindows } from "./review";
import { errorText } from "./sqlite";
import type { MemoryStore, SearchHit, SessionRow } from "./store";
import { findTaskMatches, type TaskMatches } from "./task";
import { clip } from "./text";
import { lastUpkeepRun, runUpkeep, upkeepPairs } from "./upkeep";

export interface RouteContext {
  store: MemoryStore;
  windows: ReviewWindows;
  secret: string;
  mcpUrl(): string;
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
    configure: (input) => {
      store.configure(input);
      return { ok: true };
    },
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
      const hits = await store.search({
        query: input.query,
        project,
        scope: input.scope,
        limit: input.limit,
      });
      return { items: hits.map(toItem) };
    },
    ...reviewRoutes(ctx),
    ...upkeepRoutes(store, projectOf),
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

function reviewRoutes(ctx: RouteContext): Pick<Routes, "review-start" | "review-end" | "review-skip"> {
  const { store, windows } = ctx;
  return {
    "review-start": (input) => {
      const cap = store.config.reviewMaxMemories;
      const nonce = store.audit.toolNonceFor(input.agentId);
      if (!nonce) return { ok: false, reason: "This agent has no memory tools.", cap };
      windows.open({ agentId: input.agentId, nonce, trigger: input.trigger });
      return { ok: true, reason: null, cap };
    },
    "review-end": (input) => finishReview(store, windows, input),
    "review-skip": (input) => {
      store.audit.record(store.audit.nonceFor(input.agentId), {
        kind: "review",
        trigger: input.trigger,
        status: "skipped",
        reason: input.reason,
        saved: [],
        updated: [],
        durationMs: null,
        summary: null,
      });
      return { ok: true };
    },
  };
}

type UpkeepRoutes = "upkeep-list" | "upkeep-run" | "keep" | "archive" | "dismiss-pair";

function upkeepRoutes(
  store: MemoryStore,
  projectOf: (paseoProjectId: string | null) => ProjectRef | null,
): Pick<Routes, UpkeepRoutes> {
  return {
    "upkeep-list": (input) => {
      const project = projectOf(input.paseoProjectId);
      const stale = store.list({ project, scope: "all", stale: true, limit: 50 });
      return {
        mode: store.config.duplicateMerge,
        staleDays: store.config.staleDays,
        lastRunAt: lastUpkeepRun(store),
        ...upkeepPairs(store, project),
        stale: stale.map(toItem),
      };
    },
    "upkeep-run": () => runUpkeep(store, new Date().toISOString()),
    keep: (input) => ({ ok: store.keep(input.id) }),
    archive: (input) => ({ ok: store.archive(input.id) }),
    "dismiss-pair": (input) => {
      store.dismissPair(input.a, input.b);
      return { ok: true };
    },
  };
}

async function agentContext(
  ctx: RouteContext,
  input: ServiceParsedInput<"agent-context">,
): Promise<ServiceOutputs["agent-context"]> {
  const { project, provider } = input;
  const { store } = ctx;
  if (project) store.upsertProject(project);
  const nonce = randomBytes(12).toString("base64url");
  store.audit.open({ nonce, projectKey: project?.key ?? null, provider, tools: input.includeTools });
  let systemPrompt: string | null = null;
  if (input.includeContext) {
    const task = input.task
      ? await findTaskMatches({ store, project, task: input.task, budgetMs: input.taskBudgetMs })
      : null;
    const context = buildContext({ store, project, task });
    systemPrompt = buildSystemPrompt({
      context: context.text,
      project,
      hasTools: input.includeTools,
      extraInstructions: store.config.extraInstructions,
    });
    store.markShown(context.memoryIds);
    store.audit.record(nonce, {
      kind: "inject",
      memories: context.memoryIds,
      sessions: context.sessionIds,
      chars: systemPrompt.length,
      budget: store.config.contextBudgetChars,
      task: task && taskAudit(task, context.taskIds),
    });
  }
  const caller = { projectKey: project?.key ?? null, agentId: null, provider, nonce };
  const mcpServer = input.includeTools
    ? { url: ctx.mcpUrl(), headers: signCaller(ctx.secret, caller) }
    : null;
  return { systemPrompt, mcpServer, nonce };
}

function taskAudit(task: TaskMatches, injectedIds: number[]) {
  const scores = new Map(task.hits.map((h) => [Number(h.id), h.relevance ?? h.similarity ?? h.score]));
  return {
    query: clip(redact(task.query), 200),
    source: task.source,
    matches: injectedIds.map((id) => ({ id, score: Math.round((scores.get(id) ?? 0) * 1000) / 1000 })),
    note: task.note,
  };
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
    summary: s.summary,
    outcomes: s.outcomes,
    reviewedAt: s.reviewed_at,
  };
}
