// Wires the store, MCP server, lifecycle hooks, and RPCs into the Paseo plugin runtime.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  type MemorySettings,
  PLUGIN_ID,
  attachmentSearchRpc,
  deleteMemoryRpc,
  memorySettings,
  saveMemoryRpc,
  searchMemoriesRpc,
  statusRpc,
  updateMemoryRpc,
} from "../shared/contracts";
import { digestLatestTurn } from "./capture";
import { type EmbedderState, ensureModelFiles, loadStaticEmbedder } from "./embedder";
import { MemoryMcpServer, signCaller } from "./mcp";
import { MemoryStore, type ProjectRef } from "./store";
import { MCP_INSTRUCTIONS, buildContext, buildSystemPrompt, createTools } from "./tools";

const MCP_KEY = "memory";
const DEFAULTS: MemorySettings = memorySettings.schema.parse({});

export function dataDir(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return process.env.PASEO_MEMORY_DIR || join(home, "plugin-data", PLUGIN_ID);
}

function loadSecret(dir: string): string {
  const path = join(dir, "mcp-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

interface ProjectCacheEntry {
  project: ProjectRef | null;
  at: number;
}

export function contributeServer(server: PluginServerContext): () => void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const settingsHandle = server.registerSettings(memorySettings);
  let settings: MemorySettings = DEFAULTS;
  const log = (message: string) => console.error(`[paseo-memory] ${message}`);

  const store = new MemoryStore({
    path: join(dir, "memory.db"),
    sqliteVecPath: null,
    duplicateThreshold: DEFAULTS.duplicateThreshold,
  });
  let embedderState: EmbedderState = { status: "off" };
  let mcp: MemoryMcpServer | null = null;
  let mcpState = "starting";
  const secret = loadSecret(dir);
  const projectCache = new Map<string, ProjectCacheEntry>();
  const projectsByKey = new Map<string, ProjectRef>();

  // ---- project resolution: agent cwd/workspace -> Paseo project -> stable project key ----

  async function resolveProject(paseo: PaseoApi, input: { cwd: string; workspaceId?: string | null }): Promise<ProjectRef | null> {
    const cacheKey = input.workspaceId ?? input.cwd;
    const cached = projectCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.project;
    let project: ProjectRef | null = null;
    try {
      const [{ entries }, { projects }] = await Promise.all([
        paseo.workspaces.list({ page: { limit: 200 } }),
        paseo.projects.list(),
      ]);
      const cwd = resolve(input.cwd);
      const workspace =
        (input.workspaceId ? entries.find((w) => w.id === input.workspaceId) : undefined) ??
        entries
          .filter((w) => {
            const d = w.workspaceDirectory ? resolve(w.workspaceDirectory) : null;
            return d !== null && (cwd === d || cwd.startsWith(d + sep));
          })
          .sort((a, b) => (b.workspaceDirectory?.length ?? 0) - (a.workspaceDirectory?.length ?? 0))[0];
      const projectId = workspace?.projectId;
      const descriptor = projectId
        ? (projects as { projectId: string; projectKey?: string; projectDisplayName: string; projectRootPath: string }[]).find(
            (p) => p.projectId === projectId,
          )
        : undefined;
      if (projectId && (descriptor || workspace)) {
        const rootPath = descriptor?.projectRootPath ?? workspace?.projectRootPath ?? null;
        project = {
          key: descriptor?.projectKey || (rootPath ? `path:${rootPath}` : `paseo:${projectId}`),
          name: descriptor?.projectDisplayName ?? workspace?.projectDisplayName ?? projectId,
          rootPath,
          paseoProjectId: projectId,
        };
        store.upsertProject(project);
      }
    } catch (error) {
      log(`project lookup failed: ${String(error)}`);
    }
    projectCache.set(cacheKey, { project, at: Date.now() });
    if (project) projectsByKey.set(project.key, project);
    return project;
  }

  function projectFromPaseoId(paseoProjectId: string | null): ProjectRef | null {
    return paseoProjectId ? store.projectByPaseoId(paseoProjectId) : null;
  }

  // ---- settings + background services ----

  async function applySettings(next: MemorySettings): Promise<void> {
    const portChanged = next.mcpPort !== settings.mcpPort || mcp === null;
    const embeddingsChanged = next.embeddings !== settings.embeddings || embedderState.status === "off";
    settings = next;
    if (portChanged) await restartMcp();
    if (embeddingsChanged) void loadEmbeddings();
    try {
      const pruned = store.pruneSessions(settings.sessionRetentionDays);
      if (pruned) log(`pruned ${pruned} old session digests`);
    } catch (error) {
      log(`prune failed: ${String(error)}`);
    }
  }

  async function restartMcp(): Promise<void> {
    if (mcp) await mcp.stop().catch(() => undefined);
    const next = new MemoryMcpServer({
      port: settings.mcpPort,
      secret,
      instructions: MCP_INSTRUCTIONS,
      tools: createTools({
        store,
        resolveProject: (caller) => (caller.projectKey ? (projectsByKey.get(caller.projectKey) ?? keyOnly(caller.projectKey)) : null),
        contextBudget: () => settings.contextBudgetChars,
      }),
      log,
    });
    try {
      await next.start();
      mcp = next;
      mcpState = `listening on ${next.url}`;
    } catch (error) {
      mcp = null;
      mcpState = `failed: ${String(error)}`;
      log(`MCP server failed to start on port ${settings.mcpPort}: ${String(error)}`);
    }
  }

  async function loadEmbeddings(): Promise<void> {
    if (settings.embeddings === "off") {
      embedderState = { status: "off" };
      store.setEmbedder(null);
      return;
    }
    if (embedderState.status === "loading" || embedderState.status === "ready") return;
    embedderState = { status: "loading" };
    try {
      const modelDir = await ensureModelFiles({ modelsDir: join(dir, "models") });
      const embedder = loadStaticEmbedder(modelDir);
      store.setEmbedder(embedder);
      embedderState = { status: "ready", embedder };
      log(`embeddings ready (${embedder.model}, ${embedder.dims}d, index ${store.vectorIndex})`);
    } catch (error) {
      embedderState = { status: "error", error: String(error) };
      log(`embeddings unavailable, keyword search only: ${String(error)}`);
    }
  }

  void settingsHandle.read().then(async (state) => {
    await applySettings(state.status === "ready" ? state.values : DEFAULTS);
  });
  const unsubscribeSettings = settingsHandle.subscribe(async (state) => {
    if (state.status === "ready") await applySettings(state.values);
  });

  // ---- lifecycle hooks ----

  server.before("agent.create", async ({ request }, { paseo }) => {
    try {
      const config = request.config;
      if (config.internal) return request;
      if (!settings.injectContext && !settings.injectMcp) return request;
      const project = await withTimeout(resolveProject(paseo, { cwd: config.cwd }), 2000, null);
      const providerBase = String(config.provider).split("/")[0];
      const canMcp =
        settings.injectMcp && mcp !== null && !settings.mcpDenyProviders.includes(providerBase) &&
        !Object.hasOwn(config.mcpServers ?? {}, MCP_KEY);
      const next = { ...config };
      if (canMcp && mcp) {
        next.mcpServers = {
          ...config.mcpServers,
          [MCP_KEY]: {
            type: "http",
            url: mcp.url,
            headers: signCaller(secret, { projectKey: project?.key ?? null, agentId: null, provider: providerBase }),
          },
        };
      }
      if (settings.injectContext) {
        const context = buildContext({ store, project, budgetChars: settings.contextBudgetChars });
        const block = buildSystemPrompt({ context, project, hasTools: canMcp });
        next.systemPrompt = config.systemPrompt ? `${config.systemPrompt}\n\n${block}` : block;
      }
      return { ...request, config: next };
    } catch (error) {
      log(`agent.create injection skipped: ${String(error)}`);
      return request;
    }
  });

  const seenTurns = new Set<string>();
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (!settings.autoCapture || event.outcome.kind === "canceled") return;
    const turnKey = `${event.agent.id}:${event.turnId ?? event.timeline.length}`;
    if (seenTurns.has(turnKey)) return;
    seenTurns.add(turnKey);
    if (seenTurns.size > 2000) seenTurns.clear();
    try {
      const digest = digestLatestTurn(event.timeline);
      if (!digest.userText && !digest.assistantText) return;
      const project = await resolveProject(paseo, { cwd: event.agent.cwd, workspaceId: event.agent.workspaceId });
      store.recordTurn({
        agentId: event.agent.id,
        project,
        provider: event.agent.provider,
        title: event.agent.title,
        workspaceDir: event.agent.cwd,
        userText: digest.userText,
        assistantText: digest.assistantText,
        files: digest.files,
      });
    } catch (error) {
      log(`turn capture failed: ${String(error)}`);
    }
  });

  server.on("agent.archived", (event) => {
    try {
      store.endSession(event.agent.id);
    } catch (error) {
      log(`session end failed: ${String(error)}`);
    }
  });

  server.on("workspace.created", async (event, { paseo }) => {
    projectCache.delete(event.workspace.id);
    await resolveProject(paseo, { cwd: event.workspace.cwd, workspaceId: event.workspace.id });
  });

  // ---- RPCs for the app UI ----

  server.handle(searchMemoriesRpc, (input) => {
    const project = projectFromPaseoId(input.paseoProjectId);
    return {
      items: store
        .search({ query: input.query, project, scope: input.scope, limit: input.limit })
        .map((h) => ({
          kind: h.kind,
          id: h.id,
          title: h.title,
          type: h.type,
          scope: h.scope,
          projectName: h.projectName,
          preview: h.preview,
          pinned: h.pinned,
          updatedAt: h.updatedAt,
        })),
    };
  });

  server.handle(saveMemoryRpc, async (input, { paseo }) => {
    let project = projectFromPaseoId(input.paseoProjectId);
    if (!project && input.paseoProjectId) {
      const { projects } = await paseo.projects.list();
      const d = (projects as { projectId: string; projectKey?: string; projectDisplayName: string; projectRootPath: string }[]).find(
        (p) => p.projectId === input.paseoProjectId,
      );
      if (d) {
        project = {
          key: d.projectKey || `path:${d.projectRootPath}`,
          name: d.projectDisplayName,
          rootPath: d.projectRootPath,
          paseoProjectId: d.projectId,
        };
      }
    }
    if (input.scope === "project" && !project) return { id: null, status: "error", message: "Unknown project" };
    const result = store.save({
      title: input.title,
      content: input.content,
      type: input.type,
      scope: input.scope,
      project,
      pinned: input.pinned,
      force: true,
      source: "user",
    });
    return { id: result.id, status: result.status, message: `${result.status} #${result.id ?? "-"}` };
  });

  server.handle(updateMemoryRpc, (input) => ({ ok: store.update(input.id, { pinned: input.pinned }) }));
  server.handle(deleteMemoryRpc, (input) => ({ ok: store.delete(input.id) }));

  server.handle(statusRpc, () => {
    const stats = store.stats();
    return {
      dbPath: store.path,
      ...stats,
      embeddings:
        embedderState.status === "ready"
          ? `${embedderState.embedder.model} (${embedderState.embedder.dims}d)`
          : embedderState.status === "error"
            ? `error: ${embedderState.error}`
            : embedderState.status,
      vectorIndex: store.vectorIndex,
      mcp: mcpState,
    };
  });

  server.handle(attachmentSearchRpc, (input) => ({
    items: store.search({ query: input.query, project: null, scope: "all", limit: 15 }).filter((h) => h.kind === "memory").map((h) => {
      const full = store.get([Number(h.id)])[0];
      return {
        id: h.id,
        identifier: `#${h.id}`,
        title: h.title,
        subtitle: `${h.type} · ${h.projectName ?? "global"}`,
        url: `https://paseo.sh/memory/${h.id}`,
        text: `Memory #${h.id} (${h.type}, ${h.projectName ?? "global"}): ${h.title}\n\n${full?.content ?? h.preview}`,
        resourceType: "memory",
      };
    }),
  }));

  return () => {
    unsubscribeSettings();
    void mcp?.stop();
    store.close();
  };
}

function keyOnly(key: string): ProjectRef {
  return { key, name: key.replace(/^remote:|^path:/, ""), rootPath: null, paseoProjectId: null };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
