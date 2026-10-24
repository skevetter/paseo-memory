import { randomBytes } from "node:crypto";
import type { RetrievalResult } from "../shared/retrieval";
import type {
  MemoryItem,
  ProjectRef,
  ServiceOutputs,
  ServiceParsedInput,
  ServiceRoute,
  ServiceStatus,
  SessionItem,
} from "../shared/service-api";
import { Access } from "./access";
import { retrievalAudit, retrievalScore } from "./audit";
import type { MemoryBridge } from "./bridge";
import { retrieveContext } from "./context";
import type { ContextTokenizer } from "./context-budget";
import { signCaller } from "./mcp";
import { MutationError, mutationRequestId, ownerMutation } from "./mutations";
import { redact } from "./redact";
import { finishReview } from "./review";
import type { MemoryStore, SearchHit, SessionRow } from "./store";
import type { TaskInput } from "./task";
import { clip } from "./text";
import { lastUpkeepRun, runUpkeep, upkeepPairs } from "./upkeep";

// The settings and memory panels belong to the machine owner; MCP callers never reach this principal.
const OWNER = Access.owner();

export interface RouteContext {
  store: MemoryStore;
  secret: string;
  mcpUrl(): string;
  status(): ServiceStatus;
  tokenizers?: ReadonlyMap<string, ContextTokenizer>;
  bridge: MemoryBridge;
}

export type Routes = {
  [R in ServiceRoute]: (
    input: ServiceParsedInput<R>,
    signal?: AbortSignal,
  ) => Promise<ServiceOutputs[R]> | ServiceOutputs[R];
};

export function createRoutes(ctx: RouteContext): Routes {
  const { store } = ctx;
  const projectOf = (paseoProjectId: string | null) =>
    paseoProjectId ? store.projectByPaseoId(paseoProjectId) : null;
  return {
    status: () => ctx.status(),
    "usage-record": (input) => store.usage.record("paseo_host", input),
    "context-admit": (input) => store.admitContext(input),
    "context-settle": (input) => store.usage.settleContext(input),
    ...bridgeRoutes(ctx),
    feedback: (input) => store.feedback.record(ownerMutation(OWNER), input),
    ...lifecycleRoutes(store),
    configure: (input) => {
      store.configure(input);
      return { ok: true };
    },
    "agent-context": (input, signal) => agentContext(ctx, input, signal),
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
        access: input.scope === "bot" ? OWNER : Access.owner(project?.key),
        scope: input.scope,
        limit: input.limit,
      });
      return { items: hits.map(toItem) };
    },
    ...reviewRoutes(ctx),
    ...upkeepRoutes(store, projectOf),
    save: (input) => saveFromUi(store, input),
    update: (input) => updateFromUi(store, input),
    delete: (input) => {
      store.mutations.mutate(ownerMutation(OWNER), {
        requestId: input.requestId ?? mutationRequestId(),
        operation: "archive",
        id: input.id,
        expectedRevision: input.expectedRevision,
      });
      return { ok: true };
    },
    detail: (input) => store.detailAuthorized(OWNER, input.id),
    restore: (input) => {
      store.mutations.mutate(ownerMutation(OWNER), {
        requestId: input.requestId ?? mutationRequestId(),
        operation: "restore",
        id: input.id,
        expectedRevision: input.expectedRevision,
        change: { sourceRevision: input.version },
      });
      return { ok: true };
    },
    merge: (input) => {
      store.mutations.mutate(ownerMutation(OWNER), {
        requestId: input.requestId ?? mutationRequestId(),
        operation: "merge",
        id: input.sourceId,
        expectedRevision: input.sourceRevision,
        change: { target: { id: input.targetId, revision: input.targetRevision } },
      });
      const detail = store.detailAuthorized(OWNER, input.sourceId);
      return { ok: true, message: "Merged.", mergeId: detail.mergeId, conflict: false };
    },
    "merge-undo": (input) => {
      const result = store.undoMergeAuthorized(OWNER, input.mergeId, {
        sourceRevision: input.sourceRevision,
        targetRevision: input.targetRevision,
      });
      if (!result.ok) throw new MutationError("revision_conflict", result.message);
      return result;
    },
    sessions: (input) => {
      const projectKey = projectOf(input.paseoProjectId)?.key ?? null;
      return { items: store.sessions({ projectKey, query: input.query, limit: input.limit }).map(toSession) };
    },
    "agent-audit": (input) => store.audit.agent(input.agentId),
    "workspace-agents": (input) => ({ agents: store.audit.workspaceAgents(input.workspaceId, input.limit) }),
    attachments: (input) => attachments(store, input.query),
  };
}

type BridgeRoutes =
  | "bridge-create"
  | "bridge-open"
  | "bridge-managed"
  | "bridge-status"
  | "bridge-rotate"
  | "bridge-import-preview"
  | "bridge-import";
function bridgeRoutes(ctx: RouteContext): Pick<Routes, BridgeRoutes> {
  return {
    "bridge-create": (input) => ctx.bridge.prepareCreate(input),
    "bridge-open": (input) => ctx.bridge.open(input),
    "bridge-managed": (input) => ({ agentIds: ctx.bridge.managed(input.agentIds) }),
    "bridge-status": () => ctx.bridge.sessions.ownerStatus(),
    "bridge-rotate": (input) => ctx.bridge.rotate(input),
    "bridge-import-preview": (input) => ctx.bridge.imports.preview(input),
    "bridge-import": (input) => ctx.bridge.imports.import(input),
  };
}

type LifecycleRoutes =
  | "mutate"
  | "lifecycle-detail"
  | "historical"
  | "forget-preview"
  | "evidence-artifact"
  | "source-invalidate"
  | "source-forget";

function lifecycleRoutes(store: MemoryStore): Pick<Routes, LifecycleRoutes> {
  return {
    mutate: (input) => store.mutations.mutate(ownerMutation(OWNER), input),
    "lifecycle-detail": ({ id }) => store.lifecycleDetail(OWNER, id),
    historical: ({ id, asOf }) => {
      const row = store.historical(OWNER, id, asOf);
      return row
        ? {
            memoryRef: { id: row.id, revision: row.record_revision },
            title: row.title,
            content: row.content,
            state: row.state,
            recordKind: row.record_kind,
            verificationStatus: row.verification_status,
            validFrom: row.valid_from,
            validUntil: row.valid_until,
          }
        : null;
    },
    "forget-preview": ({ id }) => store.lifecycle.preview(OWNER, id),
    "evidence-artifact": (input) => store.provenance.registerArtifact(OWNER, input),
    "source-invalidate": ({ sourceRef }) => store.invalidateSource(OWNER, sourceRef),
    "source-forget": ({ sourceRef, requestId }) => store.forgetSource(OWNER, sourceRef, requestId),
  };
}

function reviewRoutes(ctx: RouteContext): Pick<Routes, "review-start" | "review-end" | "review-skip"> {
  const { store } = ctx;
  return {
    "review-start": (input) => {
      const cap = store.config.reviewMaxMemories;
      if (ctx.bridge.managed([input.agentId]).length)
        return { ok: false, reason: "Standalone review is delegated to the registered controller.", cap };
      if (store.sessionInvalidated(input.agentId))
        return {
          ok: false,
          reason: "A source was forgotten. Start a fresh agent context before review.",
          cap,
        };
      const nonce = store.audit.toolNonceFor(input.agentId);
      if (!nonce) return { ok: false, reason: "This agent has no memory tools.", cap };
      store.openReviewWindow({ agentId: input.agentId, nonce, trigger: input.trigger, cap });
      return { ok: true, reason: null, cap };
    },
    "review-end": (input) => finishReview(store, input),
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
      const stale = store.list({ access: Access.owner(project?.key), scope: "all", stale: true, limit: 50 });
      return {
        mode: store.config.duplicateMerge,
        staleDays: store.config.staleDays,
        lastRunAt: lastUpkeepRun(store),
        ...upkeepPairs(store, project),
        stale: stale.map(toItem),
      };
    },
    "upkeep-run": () => runUpkeep(store, new Date().toISOString()),
    keep: (input) => ({ ok: store.keep(OWNER, input.id) === "ok" }),
    archive: (input) => {
      store.mutations.mutate(ownerMutation(OWNER), {
        requestId: input.requestId ?? mutationRequestId(),
        operation: "archive",
        id: input.id,
        expectedRevision: input.expectedRevision,
      });
      return { ok: true };
    },
    "dismiss-pair": (input) => {
      store.dismissPair(input.a, input.b);
      return { ok: true };
    },
  };
}

async function agentContext(
  ctx: RouteContext,
  input: ServiceParsedInput<"agent-context">,
  signal?: AbortSignal,
): Promise<ServiceOutputs["agent-context"]> {
  const { project, provider } = input;
  const { store } = ctx;
  if (project) store.upsertProject(project);
  const nonce = randomBytes(12).toString("base64url");
  store.audit.open({ nonce, projectKey: project?.key ?? null, provider, tools: input.includeTools });
  const context = input.includeContext
    ? await retrieveContext({
        store,
        project,
        task: input.task,
        request: input.retrieval,
        signal,
        projectUnresolved: input.projectUnresolved,
        hasTools: input.includeTools,
        assemblyPrefix: input.assemblyPrefix,
        maxLatencyMs: input.taskBudgetMs,
        tokenizer: ctx.tokenizers?.get(provider),
        complete: (result, scores, policy, sessionVersions) => {
          store.markShown(result.memoryRefs.map((ref) => ref.id));
          store.audit.record(nonce, {
            kind: "inject",
            memories: result.memoryRefs.map((ref) => ref.id),
            sessions: result.sessionIds,
            chars: result.usage.chars,
            budget: policy.limits.maxChars,
            retrieval: retrievalAudit(result),
            admission: {
              policyRevision: result.policyRevision,
              indexGeneration: result.indexGeneration,
              sessionVersions: [...sessionVersions]
                .filter(([id]) => result.sessionIds.includes(id))
                .map(([id, version]) => ({ id, version })),
            },
            task: input.task && taskAudit(input.task, result, scores),
          });
        },
      })
    : null;
  if (!input.includeContext && input.includeTools) {
    store.audit.record(nonce, {
      kind: "inject",
      memories: [],
      sessions: [],
      chars: 0,
      budget: 0,
      admission: {
        policyRevision: store.retrievalPolicies.revision,
        indexGeneration: store.retrievalGeneration,
        sessionVersions: [],
      },
    });
  }
  const caller = { projectKey: project?.key ?? null, agentId: null, provider, nonce };
  const mcpServer = input.includeTools
    ? { url: ctx.mcpUrl(), headers: signCaller(ctx.secret, caller) }
    : null;
  return { context, mcpServer, nonce };
}

function taskAudit(task: TaskInput, result: RetrievalResult, scores: ReadonlyMap<string, number>) {
  return {
    query: clip(redact(task.query), 200),
    source: task.source,
    matches: result.taskIds.map((id) => ({ id, score: retrievalScore(scores, `memory:${id}`) })),
    note: result.fallbackReason,
  };
}

function saveFromUi(store: MemoryStore, input: ServiceParsedInput<"save">): ServiceOutputs["save"] {
  const known = input.paseoProjectId ? store.projectByPaseoId(input.paseoProjectId) : null;
  const project: ProjectRef | null = known ?? input.project;
  if (input.scope === "project" && !project) throw new MutationError("scope_denied", "Unknown project.");
  const result = store.mutations.mutate(ownerMutation(OWNER), {
    requestId: input.requestId ?? mutationRequestId(),
    operation: "create",
    change: {
      title: input.title,
      content: input.content,
      type: input.type,
      scope: input.scope,
      project,
      botId: input.botId,
      pinned: input.pinned,
    },
  });
  return { ...result, id: result.memoryRef.id, message: `${result.status} #${result.memoryRef.id}` };
}

function updateFromUi(store: MemoryStore, input: ServiceParsedInput<"update">): ServiceOutputs["update"] {
  const known = input.paseoProjectId ? store.projectByPaseoId(input.paseoProjectId) : null;
  store.mutations.mutate(ownerMutation(OWNER), {
    requestId: input.requestId ?? mutationRequestId(),
    operation: "update",
    id: input.id,
    expectedRevision: input.expectedRevision,
    change: {
      title: input.title,
      content: input.content,
      type: input.type,
      pinned: input.pinned,
      scope: input.scope,
      botId: input.botId,
      ...(input.scope === "project" ? { project: known ?? input.project ?? null } : {}),
    },
  });
  return { ok: true, message: "Saved." };
}

async function attachments(store: MemoryStore, query: string): Promise<ServiceOutputs["attachments"]> {
  const hits = await store.search({ query, access: OWNER, scope: "all", limit: 15 });
  const items = hits
    .filter((h) => h.kind === "memory")
    .map((h) => {
      const where = h.scope === "bot" ? `bot ${h.botId}` : (h.projectName ?? "global");
      const content = store.getVisible(OWNER, [Number(h.id)])[0]?.content ?? h.preview;
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
    botId: h.kind === "memory" ? h.botId : null,
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
