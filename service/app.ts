import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { createLogger, type Logger } from "../shared/log";
import {
  type EmbedderStatus,
  type EmbeddingTier,
  type ProjectRef,
  type RerankerStatus,
  type RerankMode,
  SERVICE_KEY_HEADER,
  SERVICE_KEY_LABEL,
  type ServiceRoute,
  type ServiceStatus,
  serviceInputs,
} from "../shared/service-api";
import { type Embedder, loadEmbedder, TIERS } from "./embedder";
import { type Caller, createMcpHandler } from "./mcp";
import { loadReranker, RERANK_MODEL, type Reranker, rerankEnabled } from "./reranker";
import { createRoutes, type Routes } from "./routes";
import { errorText, FatalError } from "./sqlite";
import { MemoryStore } from "./store";
import { createTools, MCP_INSTRUCTIONS } from "./tools";
import { SERVICE_VERSION } from "./version";

export { SERVICE_VERSION };

const PRUNE_INTERVAL_MS = 12 * 3_600_000;

export interface ServiceOptions {
  dataDir: string;
  port: number;
  tier: EmbeddingTier;
  rerank?: RerankMode;
  sqlitePath?: string | null;
  modelsDir?: string;
  contextBudgetChars?: number;
  sessionRetentionDays?: number;
  log?: Logger;
  loadEmbedder?: (tier: EmbeddingTier, modelsDir: string) => Promise<Embedder>;
  loadReranker?: (modelsDir: string) => Promise<Reranker>;
}

export interface RunningService {
  store: MemoryStore;
  port: number;
  mcpUrl: string;
  secret: string;
  status(): ServiceStatus;
  modelsReady(): Promise<void>;
  stop(): Promise<void>;
}

interface ModelStates {
  embedder: EmbedderStatus;
  reranker: RerankerStatus;
}

export function loadSecret(dataDir: string): string {
  const path = join(dataDir, "mcp-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export function serviceKey(secret: string): string {
  return createHmac("sha256", secret).update(SERVICE_KEY_LABEL).digest("hex");
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const log = options.log ?? createLogger("paseo-memory-service");
  mkdirSync(options.dataDir, { recursive: true });
  const secret = loadSecret(options.dataDir);
  const store = new MemoryStore({
    path: join(options.dataDir, "memory.db"),
    sqlitePath: options.sqlitePath,
    log,
  });
  const contextBudget = options.contextBudgetChars ?? 6000;
  const models = initialStates(options);

  let mcpUrl = "";
  const status = (): ServiceStatus => serviceStatus(store, models, mcpUrl);
  const routes = createRoutes({ store, secret, contextBudget, status, mcpUrl: () => mcpUrl });
  const mcp = createMcpHandler({
    secret,
    instructions: MCP_INSTRUCTIONS,
    serverVersion: SERVICE_VERSION,
    resolveCaller: (caller) => resolveCaller(store, caller),
    tools: createTools({
      store,
      resolveProject: (caller) => callerProject(store, caller.projectKey),
      contextBudget: () => contextBudget,
    }),
  });
  const internal = createInternalHandler(routes, serviceKey(secret), log);
  const server = serve(options.port, { mcp, internal, log });
  const port = server.port ?? options.port;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;

  const pruneTimer = startPruning(store, options.sessionRetentionDays ?? 30, log);
  // Models load after the server is listening so keyword search serves requests meanwhile.
  const modelsLoaded = activateEmbedder({ store, models, options, log }).then(() =>
    activateReranker({ store, models, options, log }),
  );

  return {
    store,
    port,
    mcpUrl,
    secret,
    status,
    modelsReady: () => modelsLoaded,
    async stop() {
      clearInterval(pruneTimer);
      await server.stop(true);
      await modelsLoaded;
      store.close();
    },
  };
}

function initialStates(options: ServiceOptions): ModelStates {
  const spec = TIERS[options.tier];
  const mode = options.rerank ?? "auto";
  const enabled = rerankEnabled(mode, options.tier);
  return {
    embedder: {
      tier: options.tier,
      model: spec.model,
      dims: spec.dims,
      state: "loading",
      error: null,
      pending: 0,
    },
    reranker: { mode, enabled, model: RERANK_MODEL, state: enabled ? "loading" : "off", error: null },
  };
}

function serviceStatus(store: MemoryStore, models: ModelStates, mcpUrl: string): ServiceStatus {
  return {
    pid: process.pid,
    version: SERVICE_VERSION,
    bunVersion: Bun.version,
    sqliteVersion: store.sqliteVersion,
    sqliteLibrary: store.sqliteLibrary,
    sqliteVecVersion: store.sqliteVecVersion,
    dbPath: store.path,
    mcpUrl,
    ...store.stats(),
    embedder: { ...models.embedder, pending: store.pendingEmbeddings() },
    reranker: { ...models.reranker },
  };
}

function callerProject(store: MemoryStore, projectKey: string | null): ProjectRef | null {
  if (!projectKey) return null;
  return (
    store.projectByKey(projectKey) ?? {
      key: projectKey,
      name: projectKey.replace(/^remote:|^path:/, ""),
      rootPath: null,
      paseoProjectId: null,
    }
  );
}

function resolveCaller(store: MemoryStore, caller: Caller): Caller {
  if (caller.agentId || !caller.nonce) return caller;
  return { ...caller, agentId: store.audit.agentFor(caller.nonce) };
}

type Handler = (req: Request) => Promise<Response>;

// A port held by another program needs a settings change, so it is fatal rather than a crash loop.
function serve(port: number, handlers: { mcp: Handler; internal: Handler; log: Logger }): Server<undefined> {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/health") return Response.json({ ok: true });
        if (path === "/mcp") return handlers.mcp(req);
        if (path.startsWith("/v1/")) return handlers.internal(req);
        return Response.json({ error: "not found" }, { status: 404 });
      },
      error(error) {
        handlers.log.error(`request failed: ${errorText(error)}`);
        return Response.json({ error: "internal error" }, { status: 500 });
      },
    });
  } catch (error) {
    const inUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
    if (!inUse) throw error;
    throw new FatalError(`Port ${port} is in use by another program. Set a different memory port.`);
  }
}

function createInternalHandler(routes: Routes, key: string, log: Logger): Handler {
  const expected = Buffer.from(key);
  return async (req) => {
    const rejected = rejectInternal(req, expected);
    if (rejected) return rejected;
    const route = new URL(req.url).pathname.slice(4);
    if (!isRoute(route)) return Response.json({ error: `unknown route ${route}` }, { status: 404 });
    const parsed = serviceInputs[route].safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
    try {
      // serviceInputs[route] and routes[route] are keyed by the same route name.
      const handler = routes[route] as (input: unknown) => unknown;
      return Response.json(await handler(parsed.data));
    } catch (error) {
      log.error(`${route} failed: ${errorText(error)}`);
      return Response.json({ error: errorText(error) }, { status: 500 });
    }
  };
}

function rejectInternal(req: Request, expected: Buffer): Response | null {
  // Browser-originated requests are rejected outright (DNS rebinding, drive-by).
  if (req.headers.get("origin")) return Response.json({ error: "origin not allowed" }, { status: 403 });
  const given = Buffer.from(req.headers.get(SERVICE_KEY_HEADER) ?? "");
  // Constant-time compare so response timing does not leak the key.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return req.method === "POST" ? null : Response.json({ error: "method not allowed" }, { status: 405 });
}

function isRoute(name: string): name is ServiceRoute {
  return Object.hasOwn(serviceInputs, name);
}

function startPruning(store: MemoryStore, retentionDays: number, log: Logger): Timer {
  const prune = () => {
    try {
      const pruned = store.pruneHistory(retentionDays);
      if (pruned.sessions || pruned.audit) {
        log.info(`pruned ${pruned.sessions} session digests and ${pruned.audit} audit events`);
      }
    } catch (error) {
      log.warn(`prune failed: ${errorText(error)}`);
    }
  };
  prune();
  return setInterval(prune, PRUNE_INTERVAL_MS);
}

interface Activation {
  store: MemoryStore;
  models: ModelStates;
  options: ServiceOptions;
  log: Logger;
}

const modelsDirOf = (options: ServiceOptions) => options.modelsDir ?? join(options.dataDir, "models");

function activateEmbedder({ store, models, options, log }: Activation): Promise<void> {
  const { embedder } = models;
  return (options.loadEmbedder ?? loadEmbedder)(options.tier, modelsDirOf(options)).then(
    (loaded) => {
      store.setEmbedder(loaded);
      embedder.state = "ready";
      log.info(`embeddings ready: ${loaded.spec.model} (${loaded.spec.dims}d, tier ${options.tier})`);
    },
    (error: unknown) => {
      embedder.state = "error";
      embedder.error = errorText(error);
      log.warn(`embeddings unavailable, keyword search only: ${errorText(error)}`);
    },
  );
}

function activateReranker({ store, models, options, log }: Activation): Promise<void> {
  const { reranker } = models;
  if (!reranker.enabled) return Promise.resolve();
  return (options.loadReranker ?? loadReranker)(modelsDirOf(options)).then(
    (loaded) => {
      store.setReranker(loaded);
      reranker.state = "ready";
      log.info(`re-ranker ready: ${loaded.model}`);
    },
    (error: unknown) => {
      reranker.state = "error";
      reranker.error = errorText(error);
      log.warn(`re-ranker unavailable, using fused order: ${errorText(error)}`);
    },
  );
}
