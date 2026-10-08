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
  keepMemoryRpc,
  type MemorySettings,
  memoryDetailRpc,
  memorySettings,
  mergeMemoryRpc,
  PLUGIN_ID,
  restoreMemoryRpc,
  runtimeConfig,
  saveMemoryRpc,
  searchMemoriesRpc,
  sessionsRpc,
  statusRpc,
  updateMemoryRpc,
  upkeepListRpc,
  upkeepRunRpc,
  workspaceAgentsRpc,
} from "../shared/contracts";
import { createLogger, type Logger } from "../shared/log";
import { reviewPrompt, reviewPromptDisplay } from "../shared/review";
import { NONCE_ENV, type ProjectRef, type ServiceOutputs } from "../shared/service-api";
import { isUsableReply } from "../shared/turns";
import { digestLatestTurn, type TurnDigest } from "./capture";
import { FirstPrompts } from "./first-prompts";
import type { PaseoAgent, PaseoApi } from "./host-types";
import { AgentLinks } from "./links";
import { createProjectResolver, type ProjectResolver, projectFromDescriptor } from "./projects";
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
    try {
      return await withDeadline(injectMemory(request, paseo, state), CREATE_HOOK_BUDGET_MS, () => {
        state.log.warn("agent.create injection skipped: memory service did not answer in time");
        return request;
      });
    } catch (error) {
      state.log.warn(`agent.create injection skipped: ${String(error)}`);
      return request;
    }
  });

  server.before("agent.session_open", ({ request }) => {
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
  });
  server.on("agent.turn_ended", async (event, { paseo }) => {
    state.paseo = paseo;
    await linkByMatch(state, event.agent);
    if (!firstSighting(seenTurns, `${event.agent.id}:${event.turnId ?? event.timeline.length}`)) return;
    const digest = digestLatestTurn(event.timeline);
    if (digest.userText !== null && reviewPromptDisplay(digest.userText) !== null) {
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

// The turn-end hook can fire more than once for a turn; each turn is handled once.
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
    const handle = state.paseo?.agents.ref(agentId);
    if (!handle) return await skip("The Paseo API is not ready.");
    await handle.refresh();
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
    state.reviews.reviewStarted(handle.id);
    await handle.send(reviewPrompt({ cap, display: state.settings.reviewDisplay }));
    state.log.info(`memory review sent to agent ${handle.id}`);
  } catch (error) {
    state.reviews.reviewSkipped(handle.id);
    const input = { agentId: handle.id, reply: null, failed: true };
    await state.supervisor.call("review-end", input, RPC_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }
}

async function endReview(state: PluginState, event: TurnEnded, digest: TurnDigest): Promise<void> {
  const agentId = event.agent.id;
  state.reviews.reviewEnded(agentId);
  const failed = event.outcome.kind !== "completed" || !isUsableReply(digest.assistantText);
  const input = { agentId, reply: digest.assistantText, failed };
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
  const nonce = state.links.match(agent.id, agent.cwd, agent.provider);
  if (nonce) await linkAgent(state, nonce, agent, "cwd match");
}

async function captureTurn(
  event: TurnEnded,
  digest: TurnDigest,
  ctx: { paseo: PaseoApi; state: PluginState },
): Promise<void> {
  if (!isUsableReply(digest.assistantText)) return;
  const { agent } = event;
  const project = await ctx.state.projects.resolve(ctx.paseo, {
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
  });
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
): Promise<AgentCreateRequest> {
  const started = Date.now();
  const { settings } = state;
  const config = request.config;
  if (config.internal || (!settings.injectContext && !settings.injectMcp)) return request;
  const project = await withDeadline(
    state.projects.resolve(paseo, { cwd: config.cwd }),
    PROJECT_LOOKUP_MS,
    () => null,
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
      provider,
      includeContext: settings.injectContext,
      includeTools,
      task: settings.injectContext ? agentTask(state, config, project) : null,
      taskBudgetMs: Math.max(0, remaining - CONTEXT_RESERVE_MS),
    },
    remaining,
  );
  if (injected.nonce) state.links.add(injected.nonce, config.cwd, String(config.provider));
  return withInjection(request, injected);
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
): AgentCreateRequest {
  const config = request.config;
  const next = { ...config };
  if (injected.mcpServer) {
    next.mcpServers = { ...config.mcpServers, [MCP_KEY]: { type: "http", ...injected.mcpServer } };
  }
  if (injected.systemPrompt) {
    next.systemPrompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${injected.systemPrompt}`
      : injected.systemPrompt;
  }
  const env = injected.nonce ? { ...request.env, [NONCE_ENV]: injected.nonce } : request.env;
  return { ...request, config: next, ...(env ? { env } : {}) };
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
  server.handle(saveMemoryRpc, async (input, { paseo }) => {
    const project = await projectForSave(paseo, input.paseoProjectId, state);
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
    return { service: supervisor.snapshot(), paths: supervisor.paths(), live };
  });
}
