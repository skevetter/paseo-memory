import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginBeforeRequests,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import {
  agentAuditRpc,
  attachmentSearchRpc,
  deleteMemoryRpc,
  type MemorySettings,
  memoryDetailRpc,
  memorySettings,
  mergeMemoryRpc,
  PLUGIN_ID,
  restoreMemoryRpc,
  saveMemoryRpc,
  searchMemoriesRpc,
  sessionsRpc,
  statusRpc,
  updateMemoryRpc,
  workspaceAgentsRpc,
} from "../shared/contracts";
import { createLogger, type Logger } from "../shared/log";
import { NONCE_ENV, type ProjectRef, type ServiceOutputs } from "../shared/service-api";
import { isUsableReply } from "../shared/turns";
import { digestLatestTurn } from "./capture";
import { AgentLinks } from "./links";
import { createProjectResolver, type ProjectResolver, projectFromDescriptor } from "./projects";
import { type ServiceConfig, ServiceSupervisor } from "./supervisor";

const MCP_KEY = "memory";
const DEFAULTS: MemorySettings = memorySettings.schema.parse({});
// before("agent.create") blocks agent creation, so it gets one overall deadline.
const CREATE_HOOK_BUDGET_MS = 1800;
const PROJECT_LOOKUP_MS = 1000;
const RPC_TIMEOUT_MS = 5000;

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type HookAgent = PluginLifecycleEvents["agent.created"]["agent"];

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
    contextBudgetChars: settings.contextBudgetChars,
    sessionRetentionDays: settings.sessionRetentionDays,
  };
}

interface PluginState {
  settings: MemorySettings;
  supervisor: ServiceSupervisor;
  projects: ProjectResolver;
  links: AgentLinks;
  log: Logger;
}

export function contributeServer(server: PluginServerContext): () => Promise<void> {
  const log = createLogger(PLUGIN_ID);
  const supervisor = new ServiceSupervisor({ dataDir: dataDir(), paseoHome: paseoHome(), log });
  const state: PluginState = {
    settings: DEFAULTS,
    supervisor,
    log,
    links: new AgentLinks(),
    projects: createProjectResolver(
      (project) => {
        supervisor.call("project-upsert", { project }, RPC_TIMEOUT_MS).catch(() => undefined);
      },
      (message) => log.warn(message),
    ),
  };

  const settingsHandle = server.registerSettings(memorySettings);
  const apply = async (settings: MemorySettings) => {
    state.settings = settings;
    await supervisor.configure(serviceConfig(settings));
  };
  settingsHandle
    .read()
    .then((read) => apply(read.status === "ready" ? read.values : DEFAULTS))
    .catch((error: unknown) => log.error(`settings read failed: ${String(error)}`));
  const unsubscribe = settingsHandle.subscribe(async (read) => {
    if (read.status === "ready") await apply(read.values);
  });

  registerHooks(server, state);
  registerRpcs(server, state);

  return async () => {
    await unsubscribe();
    await supervisor.stop();
  };
}

function registerHooks(server: PluginServerContext, state: PluginState): void {
  server.before("agent.create", async ({ request }, { paseo }) => {
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

  registerTurnHook(server, state);

  server.on("agent.archived", async (event) => {
    await state.supervisor
      .call("end-session", { agentId: event.agent.id }, RPC_TIMEOUT_MS)
      .catch((error: unknown) => state.log.warn(`session end failed: ${String(error)}`));
  });

  server.on("workspace.created", async (event, { paseo }) => {
    state.projects.forget(event.workspace.id);
    await state.projects.resolve(paseo, { cwd: event.workspace.cwd, workspaceId: event.workspace.id });
  });
}

function registerTurnHook(server: PluginServerContext, state: PluginState): void {
  const seenTurns = new Set<string>();
  server.on("agent.turn_ended", async (event, { paseo }) => {
    await linkByMatch(state, event.agent);
    if (!state.settings.autoCapture || event.outcome.kind !== "completed") return;
    // The hook can fire more than once for a turn; record each turn once.
    const turnKey = `${event.agent.id}:${event.turnId ?? event.timeline.length}`;
    if (seenTurns.has(turnKey)) return;
    if (seenTurns.size > 2000) seenTurns.clear();
    seenTurns.add(turnKey);
    await captureTurn(event, paseo, state).catch((error: unknown) =>
      state.log.warn(`turn capture failed: ${String(error)}`),
    );
  });
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
  event: PluginLifecycleEvents["agent.turn_ended"],
  paseo: PaseoApi,
  state: PluginState,
): Promise<void> {
  const digest = digestLatestTurn(event.timeline);
  if (!isUsableReply(digest.assistantText)) return;
  const { agent } = event;
  const project = await state.projects.resolve(paseo, { cwd: agent.cwd, workspaceId: agent.workspaceId });
  const turn = {
    agentId: agent.id,
    project,
    provider: agent.provider,
    title: agent.title,
    workspaceDir: agent.cwd,
  };
  await state.supervisor.call("record-turn", { ...turn, ...digest }, RPC_TIMEOUT_MS);
}

async function injectMemory(
  request: AgentCreateRequest,
  paseo: PaseoApi,
  state: PluginState,
): Promise<AgentCreateRequest> {
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
  const remaining = Math.max(200, CREATE_HOOK_BUDGET_MS - PROJECT_LOOKUP_MS);
  const injected = await state.supervisor.call(
    "agent-context",
    { project, provider, includeContext: settings.injectContext, includeTools },
    remaining,
  );
  if (injected.nonce) state.links.add(injected.nonce, config.cwd, String(config.provider));
  return withInjection(request, injected);
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
  server.handle(statusRpc, async () => {
    const live = supervisor.running
      ? await supervisor.call("status", {}, 1500).catch(() => supervisor.lastStatus())
      : null;
    return { service: supervisor.snapshot(), paths: supervisor.paths(), live };
  });
}
