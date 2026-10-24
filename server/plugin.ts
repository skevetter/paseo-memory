import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  PluginBeforeRequests,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import {
  agentAuditRpc,
  archiveMemoryRpc,
  attachmentSearchRpc,
  deleteMemoryRpc,
  dismissPairRpc,
  evidenceArtifactRpc,
  forgetPreviewRpc,
  forgetSourceRpc,
  invalidateSourceRpc,
  keepMemoryRpc,
  type MemorySettings,
  memoryDetailRpc,
  memoryHistoricalRpc,
  memoryLifecycleRpc,
  memorySettings,
  mergeMemoryRpc,
  mutateMemoryRpc,
  PLUGIN_ID,
  restoreMemoryRpc,
  runtimeConfig,
  saveMemoryRpc,
  searchMemoriesRpc,
  sessionsRpc,
  statusRpc,
  undoMergeRpc,
  updateMemoryRpc,
  upkeepListRpc,
  upkeepRunRpc,
  workspaceAgentsRpc,
} from "../shared/contracts";
import { createLogger, type Logger } from "../shared/log";
import { reviewPrompt, reviewPromptDisplay } from "../shared/review";
import { NONCE_ENV, type ProjectRef, type ServiceOutputs } from "../shared/service-api";
import { isUsableReply } from "../shared/turns";
import { NativeBridgeHooks } from "./bridge";
import { digestLatestTurn, type TurnDigest } from "./capture";
import { FirstPrompts } from "./first-prompts";
import type { PaseoAgent, PaseoApi } from "./host-types";
import { AgentLinks } from "./links";
import {
  createProjectResolver,
  type ProjectResolution,
  type ProjectResolver,
  projectFromDescriptor,
} from "./projects";
import { ReviewScheduler, type ReviewTrigger, type TurnResult } from "./review";
import { type ServiceConfig, ServiceSupervisor } from "./supervisor";
import { readBranch, type TaskQuery, taskQuery } from "./task-query";

const MCP_KEY = "memory";
const DEFAULTS: MemorySettings = memorySettings.schema.parse({});
// before("agent.create") blocks agent creation, so it gets one overall deadline.
const CREATE_HOOK_BUDGET_MS = 1800;
const PROJECT_LOOKUP_MS = 1000;
// Time kept back from the task search for building the block and the round trip.
const CONTEXT_RESERVE_MS = 400;
const RPC_TIMEOUT_MS = 5000;

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type HookAgent = PluginLifecycleEvents["agent.created"]["agent"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

interface InjectionDelivery {
  expired: boolean;
  deadline: number;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  const expired = Promise.withResolvers<T>();
  const timer = setTimeout(() => expired.resolve(fallback()), ms);
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export function paseoHome(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

export function dataDir(): string {
  return process.env.PASEO_MEMORY_DIR || join(paseoHome(), "plugin-data", PLUGIN_ID);
}

export function serviceConfig(settings: MemorySettings): ServiceConfig {
  return {
    bunPath: settings.bunPath,
    servicePath: settings.servicePath,
    sqlitePath: settings.sqlitePath,
    tier: settings.embeddingTier,
    rerank: settings.rerank,
    port: settings.mcpPort,
    sessionRetentionDays: settings.sessionRetentionDays,
  };
}

interface PluginState {
  settings: MemorySettings;
  supervisor: ServiceSupervisor;
  projects: ProjectResolver;
  links: AgentLinks;
  firstPrompts: FirstPrompts;
  reviews: ReviewScheduler;
  bridge: NativeBridgeHooks;
  // Paseo gives plugins one API client per process, so a handle from any hook stays valid for timers.
  paseo: PaseoApi | null;
  log: Logger;
}

export function contributeServer(server: PluginServerContext): () => Promise<void> {
  const state = createState();
  const settingsHandle = server.registerSettings(memorySettings);
  const apply = async (settings: MemorySettings) => {
    state.settings = settings;
    await state.supervisor.configure(serviceConfig(settings));
    pushRuntime(state);
  };
  settingsHandle
    .read()
    .then((read) => apply(read.status === "ready" ? read.values : DEFAULTS))
    .catch((error: unknown) => state.log.error(`settings read failed: ${String(error)}`));
  const unsubscribe = settingsHandle.subscribe(async (read) => {
    if (read.status === "ready") await apply(read.values);
  });

  registerHooks(server, state);
  registerTurnHooks(server, state);
  registerRpcs(server, state);

  return async () => {
    await unsubscribe();
    await state.supervisor.stop();
  };
}

function createState(): PluginState {
  const log = createLogger(PLUGIN_ID);
  const state: PluginState = {
    settings: DEFAULTS,
    log,
    paseo: null,
    links: new AgentLinks(),
    firstPrompts: new FirstPrompts(),
    bridge: new NativeBridgeHooks({
      dataDir: dataDir(),
      supervisor: () => state.supervisor,
      enabled: () => state.settings.bridge.enabled,
      injectTools: () => state.settings.injectMcp,
      deniedProviders: () => state.settings.mcpDenyProviders,
    }),
    supervisor: new ServiceSupervisor({
      dataDir: dataDir(),
      paseoHome: paseoHome(),
      log,
      onReady: () => pushRuntime(state),
    }),
    projects: createProjectResolver(
      (project) => {
        state.supervisor.call("project-upsert", { project }, RPC_TIMEOUT_MS).catch(() => undefined);
      },
      (message) => log.warn(message),
    ),
    reviews: new ReviewScheduler({
      policy: () => ({
        mode: state.settings.reviewTrigger,
        idleMs: state.settings.reviewIdleMinutes * 60_000,
        everyTurns: state.settings.reviewEveryTurns,
      }),
      fire: (agentId, trigger) => void runReview(state, agentId, trigger),
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    }),
  };
  return state;
}

// Counts, budget and upkeep settings live in the running service, so they change without a restart.
function pushRuntime(state: PluginState): void {
  if (!state.supervisor.running) return;
  state.supervisor
    .call("configure", runtimeConfig(state.settings), RPC_TIMEOUT_MS)
    .catch((error: unknown) => state.log.warn(`runtime settings not applied: ${String(error)}`));
}

function registerHooks(server: PluginServerContext, state: PluginState): void {
  server.before("workspace.create", ({ request }, { paseo }) => {
    state.paseo = paseo;
    if (state.firstPrompts.remember(request)) {
      state.log.info(`first message kept for the agent of a new ${request.source.kind} workspace`);
    }
    return request;
  });

  server.before("agent.create", async ({ request }, { paseo }) => {
    state.paseo = paseo;
    // Managed creation is deliberately outside the standalone fail-open injection path.
    if (state.bridge.bootstrap(request)) return state.bridge.create(request, CREATE_HOOK_BUDGET_MS);
    const delivery: InjectionDelivery = {
      expired: false,
      deadline: Date.now() + CREATE_HOOK_BUDGET_MS,
    };
    try {
      return await withDeadline(injectMemory(request, paseo, state, delivery), CREATE_HOOK_BUDGET_MS, () => {
        delivery.expired = true;
        state.log.warn("agent.create injection skipped: memory service did not answer in time");
        return request;
      });
    } catch (error) {
      delivery.expired = true;
      state.log.warn(`agent.create injection skipped: ${String(error)}`);
      return request;
    }
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.purpose === "history") return state.bridge.history(request);
    if (state.bridge.managed(request.agentId)) {
      state.reviews.forget(request.agentId);
      return state.bridge.open(request, CREATE_HOOK_BUDGET_MS);
    }
    const nonce = request.reason === "create" ? request.env[NONCE_ENV] : undefined;
    if (!nonce) return;
    state.links.claim(nonce, request.agentId);
    const agent = { id: request.agentId, workspaceId: request.workspaceId, title: null };
    void linkAgent(state, nonce, agent, "session_open");
  });

  server.on("agent.created", async (event) => {
    await linkByMatch(state, event.agent);
  });

  server.on("agent.archived", async (event) => {
    state.reviews.forget(event.agent.id);
    if (state.bridge.managed(event.agent.id)) return;
    await state.supervisor
      .call("end-session", { agentId: event.agent.id }, RPC_TIMEOUT_MS)
      .catch((error: unknown) => state.log.warn(`session end failed: ${String(error)}`));
  });

  server.on("agent.closed", (event) => state.reviews.forget(event.agent.id));

  server.on("workspace.created", async (event, { paseo }) => {
    state.projects.forget(event.workspace.id);
    await state.projects.resolve(paseo, { cwd: event.workspace.cwd, workspaceId: event.workspace.id });
  });
}

function registerTurnHooks(server: PluginServerContext, state: PluginState): void {
  const seenTurns = new Set<string>();
  server.on("agent.turn_started", (event, { paseo }) => {
    state.paseo = paseo;
    state.reviews.turnStarted(event.agent.id);
    if (state.bridge.managed(event.agent.id)) state.reviews.forget(event.agent.id);
  });
  server.on("agent.turn_ended", async (event, { paseo }) => {
    state.paseo = paseo;
    const turnKey = await recordNativeTurn(state, event);
    if (state.bridge.managed(event.agent.id)) {
      state.reviews.forget(event.agent.id);
      return;
    }
    await linkByMatch(state, event.agent);
    if (turnKey && !firstSighting(seenTurns, turnKey)) return;
    const digest = digestLatestTurn(event.timeline);
    if (isReviewReply(digest)) {
      await endReview(state, event, digest);
      return;
    }
    trackTurn(state, event, digest);
    if (!state.settings.autoCapture || event.outcome.kind !== "completed") return;
    await captureTurn(event, digest, { paseo, state }).catch((error: unknown) =>
      state.log.warn(`turn capture failed: ${String(error)}`),
    );
  });
}

function isReviewReply(digest: TurnDigest): boolean {
  return digest.userText !== null && reviewPromptDisplay(digest.userText) !== null;
}

async function recordNativeTurn(state: PluginState, event: TurnEnded): Promise<string | null> {
  if (!event.turnId) {
    state.log.warn(
      `native turn usage omitted for agent ${event.agent.id}: the host supplied no turn identity`,
    );
    return null;
  }
  const turnKey = `native-turn:${createHash("sha256")
    .update(JSON.stringify([event.agent.id, event.turnId]))
    .digest("hex")}`;
  // SDK 0.11 has no event-correlated session epoch or scoped billing. Reopened IDs may coalesce.
  await state.supervisor
    .call(
      "usage-record",
      {
        eventId: `ended:${turnKey}`,
        attemptId: turnKey,
        sourceSequence: 0,
        stage: "provider_turn",
        status: event.outcome.kind === "canceled" ? "cancelled" : event.outcome.kind,
        provenance: "unavailable",
        sourceEventId: turnKey,
        model: null,
        inputTokens: null,
        outputTokens: null,
        costAmount: null,
        currency: null,
      },
      RPC_TIMEOUT_MS,
    )
    .catch((error: unknown) => state.log.warn(`native turn usage not recorded: ${String(error)}`));
  return turnKey;
}

// Only an actual non-null host identity deduplicates capture; timeline length is not a turn identity.
function firstSighting(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size > 2000) seen.clear();
  seen.add(key);
  return true;
}

function trackTurn(state: PluginState, event: TurnEnded, digest: TurnDigest): void {
  const { agent } = event;
  const provider = agent.provider.split("/")[0] ?? "";
  if (state.settings.mcpDenyProviders.includes(provider)) return;
  const completed = event.outcome.kind === "completed" && isUsableReply(digest.assistantText);
  const result: TurnResult = completed
    ? "completed"
    : event.outcome.kind === "canceled"
      ? "canceled"
      : "failed";
  const note = state.reviews.turnEnded(agent.id, result);
  state.log.info(`memory review for agent ${agent.id}: ${note}`);
}

function busyReason(agent: PaseoAgent | null): string | null {
  if (!agent) return "The agent was not found.";
  if (agent.archivedAt) return "The agent is archived.";
  if (agent.status === "closed" || agent.status === "error") return `The agent is ${agent.status}.`;
  if (agent.pendingPermissions.length > 0) return "The agent is waiting for a permission answer.";
  if (agent.status !== "idle" || agent.activeTurn) return "The agent is busy.";
  return null;
}

async function runReview(state: PluginState, agentId: string, trigger: ReviewTrigger): Promise<void> {
  const { supervisor } = state;
  const skip = async (reason: string) => {
    state.reviews.reviewSkipped(agentId);
    state.log.info(`memory review skipped for agent ${agentId}: ${reason}`);
    await supervisor.call("review-skip", { agentId, trigger, reason }, RPC_TIMEOUT_MS).catch(() => undefined);
  };
  try {
    if (state.bridge.managed(agentId)) {
      state.reviews.forget(agentId);
      return;
    }
    const handle = state.paseo?.agents.ref(agentId);
    if (!handle) return await skip("The Paseo API is not ready.");
    await handle.refresh();
    if (state.bridge.managed(agentId)) {
      state.reviews.forget(agentId);
      return;
    }
    const busy = busyReason(handle.current());
    if (busy) return await skip(busy);
    const started = await supervisor.call("review-start", { agentId, trigger }, RPC_TIMEOUT_MS);
    if (!started.ok) return await skip(started.reason ?? "The memory service declined the review.");
    await sendReview(state, handle, started.cap);
  } catch (error) {
    await skip(`The review could not start: ${String(error)}`);
  }
}

async function sendReview(
  state: PluginState,
  handle: { id: string; send(text: string): Promise<void> },
  cap: number,
): Promise<void> {
  try {
    if (state.bridge.managed(handle.id)) {
      state.reviews.forget(handle.id);
      await state.supervisor.call(
        "review-end",
        { agentId: handle.id, reply: null, outcome: "cancelled", turnId: null },
        RPC_TIMEOUT_MS,
      );
      return;
    }
    state.reviews.reviewStarted(handle.id);
    await handle.send(reviewPrompt({ cap, display: state.settings.reviewDisplay }));
    state.log.info(`memory review sent to agent ${handle.id}`);
  } catch (error) {
    state.reviews.reviewSkipped(handle.id);
    const input = { agentId: handle.id, reply: null, outcome: "failed" as const, turnId: null };
    await state.supervisor.call("review-end", input, RPC_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }
}

async function endReview(state: PluginState, event: TurnEnded, digest: TurnDigest): Promise<void> {
  const agentId = event.agent.id;
  state.reviews.reviewEnded(agentId);
  const outcome = event.outcome.kind === "canceled" ? "cancelled" : event.outcome.kind;
  const reply = isUsableReply(digest.assistantText) ? digest.assistantText : null;
  const input = { agentId, reply, outcome, turnId: event.turnId } as const;
  await state.supervisor
    .call("review-end", input, RPC_TIMEOUT_MS)
    .then((result) =>
      state.log.info(
        `memory review finished for agent ${agentId}: saved [${result.saved.join(", ")}], updated [${result.updated.join(", ")}]`,
      ),
    )
    .catch((error: unknown) => state.log.warn(`memory review result not stored: ${String(error)}`));
}

async function linkAgent(
  state: PluginState,
  nonce: string,
  agent: { id: string; workspaceId: string | null; title: string | null },
  via: "session_open" | "cwd match",
): Promise<void> {
  const input = { nonce, agentId: agent.id, workspaceId: agent.workspaceId, title: agent.title };
  await state.supervisor
    .call("link-agent", input, RPC_TIMEOUT_MS)
    .then(() => state.log.info(`linked agent ${agent.id} to its memory audit via ${via}`))
    .catch((error: unknown) => state.log.warn(`agent link failed: ${String(error)}`));
}

async function linkByMatch(state: PluginState, agent: HookAgent): Promise<void> {
  if (state.bridge.managed(agent.id)) return;
  const nonce = state.links.match(agent.id, agent.cwd, agent.provider);
  if (nonce) await linkAgent(state, nonce, agent, "cwd match");
}

async function captureTurn(
  event: TurnEnded,
  digest: TurnDigest,
  ctx: { paseo: PaseoApi; state: PluginState },
): Promise<void> {
  if (!isUsableReply(digest.assistantText)) return;
  if (ctx.state.bridge.managed(event.agent.id)) return;
  const { agent } = event;
  const { project } = await ctx.state.projects.resolve(ctx.paseo, {
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
  });
  if (ctx.state.bridge.managed(agent.id)) return;
  const turn = {
    agentId: agent.id,
    project,
    provider: agent.provider,
    title: agent.title,
    workspaceDir: agent.cwd,
  };
  await ctx.state.supervisor.call("record-turn", { ...turn, ...digest }, RPC_TIMEOUT_MS);
}

async function injectMemory(
  request: AgentCreateRequest,
  paseo: PaseoApi,
  state: PluginState,
  delivery: InjectionDelivery,
): Promise<AgentCreateRequest> {
  const started = Date.now();
  const { settings } = state;
  const config = request.config;
  if (config.internal || (!settings.injectContext && !settings.injectMcp)) return request;
  const { project, unresolved } = await withDeadline(
    state.projects.resolve(paseo, { cwd: config.cwd }),
    PROJECT_LOOKUP_MS,
    (): ProjectResolution => ({ project: null, unresolved: "deadline" }),
  );
  const provider = String(config.provider).split("/")[0] ?? "";
  const includeTools =
    settings.injectMcp &&
    !settings.mcpDenyProviders.includes(provider) &&
    !Object.hasOwn(config.mcpServers ?? {}, MCP_KEY);
  const remaining = Math.max(200, CREATE_HOOK_BUDGET_MS - (Date.now() - started));
  const injected = await state.supervisor.call(
    "agent-context",
    {
      project,
      projectUnresolved: unresolved,
      provider,
      includeContext: settings.injectContext,
      includeTools,
      task: settings.injectContext ? agentTask(state, config, project) : null,
      taskBudgetMs: Math.max(0, remaining - CONTEXT_RESERVE_MS),
      assemblyPrefix: config.systemPrompt ?? "",
    },
    remaining,
  );
  if (!(await admitInjection(state, injected, delivery))) {
    settleInjection(state, injected, "discarded");
    return request;
  }
  return withInjection(request, injected, state, delivery);
}

// Current at the service read snapshot; later revocation can race the reply or hook return.
// The SDK exposes no atomic handoff to provider execution.
async function admitInjection(
  state: PluginState,
  injected: ServiceOutputs["agent-context"],
  delivery: InjectionDelivery,
): Promise<boolean> {
  if (delivery.expired || !injected.nonce) return false;
  const remaining = delivery.deadline - Date.now();
  if (remaining <= 0) return false;
  try {
    const result = await state.supervisor.call(
      "context-admit",
      {
        retrievalId: injected.context?.retrievalId ?? null,
        nonce: injected.nonce,
      },
      remaining,
    );
    return result.admitted === true && !delivery.expired && Date.now() < delivery.deadline;
  } catch (error) {
    state.log.warn(`agent-create context admission failed: ${String(error)}`);
    return false;
  }
}

function settleInjection(
  state: PluginState,
  injected: ServiceOutputs["agent-context"],
  status: "attached" | "discarded",
): void {
  if (!injected.context) return;
  if (!injected.nonce) {
    state.log.warn("agent-create fragment settlement skipped: the issued context has no nonce");
    return;
  }
  // The chosen hook output is known; provider consumption is not. Telemetry cannot delay or discard it.
  void state.supervisor
    .call(
      "context-settle",
      {
        retrievalId: injected.context.retrievalId,
        nonce: injected.nonce,
        status,
      },
      RPC_TIMEOUT_MS,
    )
    .catch((error: unknown) => state.log.warn(`agent-create fragment settlement failed: ${String(error)}`));
}

function agentTask(
  state: PluginState,
  config: AgentCreateRequest["config"],
  project: ProjectRef | null,
): TaskQuery | null {
  const prompt = state.firstPrompts.take({
    cwd: config.cwd,
    projectId: project?.paseoProjectId ?? null,
    projectRoot: project?.rootPath ?? null,
  });
  const names = { title: config.title ?? null, branch: readBranch(config.cwd), folder: basename(config.cwd) };
  return taskQuery({ prompt, ...names });
}

function withInjection(
  request: AgentCreateRequest,
  injected: ServiceOutputs["agent-context"],
  state: PluginState,
  delivery: InjectionDelivery,
): AgentCreateRequest {
  if (delivery.expired || Date.now() >= delivery.deadline) {
    settleInjection(state, injected, "discarded");
    return request;
  }
  const config = request.config;
  const next = { ...config };
  if (injected.mcpServer) {
    next.mcpServers = { ...config.mcpServers, [MCP_KEY]: { type: "http", ...injected.mcpServer } };
  }
  if (injected.context?.contextText) {
    next.systemPrompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${injected.context.contextText}`
      : injected.context.contextText;
  }
  const env = injected.nonce ? { ...request.env, [NONCE_ENV]: injected.nonce } : request.env;
  const output = { ...request, config: next, ...(env ? { env } : {}) };
  if (injected.nonce) state.links.add(injected.nonce, config.cwd, String(config.provider));
  settleInjection(state, injected, injected.context?.contextText ? "attached" : "discarded");
  return output;
}

async function projectForSave(
  paseo: PaseoApi,
  paseoProjectId: string | null,
  state: PluginState,
): Promise<ProjectRef | null> {
  if (!paseoProjectId) return null;
  const { known } = await state.supervisor.call("project-known", { paseoProjectId }, RPC_TIMEOUT_MS);
  if (known) return null;
  const { projects } = await paseo.projects.list();
  const descriptor = projects.find((p) => p.projectId === paseoProjectId);
  return descriptor ? projectFromDescriptor(descriptor) : null;
}

function registerRpcs(server: PluginServerContext, state: PluginState): void {
  const { supervisor } = state;
  const call = supervisor.call.bind(supervisor);
  server.handle(searchMemoriesRpc, (input) => call("search", input, RPC_TIMEOUT_MS));
  server.handle(mutateMemoryRpc, (input) => call("mutate", input, RPC_TIMEOUT_MS));
  server.handle(memoryLifecycleRpc, (input) => call("lifecycle-detail", input, RPC_TIMEOUT_MS));
  server.handle(memoryHistoricalRpc, (input) => call("historical", input, RPC_TIMEOUT_MS));
  server.handle(forgetPreviewRpc, (input) => call("forget-preview", input, RPC_TIMEOUT_MS));
  server.handle(evidenceArtifactRpc, (input) => call("evidence-artifact", input, RPC_TIMEOUT_MS));
  server.handle(invalidateSourceRpc, (input) => call("source-invalidate", input, RPC_TIMEOUT_MS));
  server.handle(forgetSourceRpc, (input) => call("source-forget", input, RPC_TIMEOUT_MS));
  server.handle(saveMemoryRpc, async (input, { paseo }) => {
    const project =
      input.scope === "project" ? await projectForSave(paseo, input.paseoProjectId, state) : null;
    return call("save", { ...input, project }, RPC_TIMEOUT_MS);
  });
  server.handle(updateMemoryRpc, async (input, { paseo }) => {
    const project =
      input.scope === "project" ? await projectForSave(paseo, input.paseoProjectId ?? null, state) : null;
    return call("update", { ...input, project }, RPC_TIMEOUT_MS);
  });
  server.handle(deleteMemoryRpc, (input) => call("delete", input, RPC_TIMEOUT_MS));
  server.handle(memoryDetailRpc, (input) => call("detail", input, RPC_TIMEOUT_MS));
  server.handle(restoreMemoryRpc, (input) => call("restore", input, RPC_TIMEOUT_MS));
  server.handle(mergeMemoryRpc, (input) => call("merge", input, RPC_TIMEOUT_MS));
  server.handle(undoMergeRpc, (input) => call("merge-undo", input, RPC_TIMEOUT_MS));
  server.handle(sessionsRpc, (input) => call("sessions", input, RPC_TIMEOUT_MS));
  server.handle(agentAuditRpc, (input) => call("agent-audit", input, RPC_TIMEOUT_MS));
  server.handle(workspaceAgentsRpc, (input) => call("workspace-agents", input, RPC_TIMEOUT_MS));
  server.handle(attachmentSearchRpc, (input) => call("attachments", input, RPC_TIMEOUT_MS));
  server.handle(upkeepListRpc, (input) => call("upkeep-list", input, RPC_TIMEOUT_MS));
  server.handle(upkeepRunRpc, (input) => call("upkeep-run", input, 30_000));
  server.handle(keepMemoryRpc, (input) => call("keep", input, RPC_TIMEOUT_MS));
  server.handle(archiveMemoryRpc, (input) => call("archive", input, RPC_TIMEOUT_MS));
  server.handle(dismissPairRpc, (input) => call("dismiss-pair", input, RPC_TIMEOUT_MS));
  server.handle(statusRpc, async () => {
    const live = supervisor.running
      ? await supervisor.call("status", {}, 1500).catch(() => supervisor.lastStatus())
      : null;
    const base = { service: supervisor.snapshot(), paths: supervisor.paths() };
    if (!live) return { ...base, live: null, resources: null };
    const { resources, ...summary } = live;
    return { ...base, live: summary, resources };
  });
}
