// The memory service: one SQLite store, the agents' MCP endpoint, and the plugin's internal API,
// served by one Bun HTTP server on 127.0.0.1.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import {
  type EmbedderStatus,
  type EmbeddingTier,
  type ProjectRef,
  SERVICE_KEY_HEADER,
  SERVICE_KEY_LABEL,
  type ServiceRoute,
  type ServiceStatus,
  serviceInputs,
} from "../shared/service-api";
import { type Embedder, loadEmbedder, TIERS } from "./embedder";
import { createMcpHandler } from "./mcp";
import { createRoutes, type Routes } from "./routes";
import { errorText } from "./sqlite";
import { MemoryStore } from "./store";
import { createTools, MCP_INSTRUCTIONS } from "./tools";

export const SERVICE_VERSION = "0.2.0";
const PRUNE_INTERVAL_MS = 12 * 3_600_000;

export interface ServiceOptions {
  dataDir: string;
  port: number;
  tier: EmbeddingTier;
  sqlitePath?: string | null;
  modelsDir?: string;
  contextBudgetChars?: number;
  sessionRetentionDays?: number;
  log?: (message: string) => void;
  // Test seam: tests inject a preloaded embedder instead of downloading models.
  loadEmbedder?: (tier: EmbeddingTier, modelsDir: string) => Promise<Embedder>;
}

export interface RunningService {
  store: MemoryStore;
  port: number;
  mcpUrl: string;
  secret: string;
  status(): ServiceStatus;
  embedderReady(): Promise<void>;
  stop(): Promise<void>;
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
  const log = options.log ?? ((message: string) => console.error(`[paseo-memory-service] ${message}`));
  mkdirSync(options.dataDir, { recursive: true });
  const secret = loadSecret(options.dataDir);
  const store = new MemoryStore({
    path: join(options.dataDir, "memory.db"),
    sqlitePath: options.sqlitePath,
    log,
  });
  const contextBudget = options.contextBudgetChars ?? 6000;
  const spec = TIERS[options.tier];
  const embedder: EmbedderStatus = {
    tier: options.tier,
    model: spec.model,
    dims: spec.dims,
    state: "loading",
    error: null,
    pending: 0,
  };

  let mcpUrl = "";
  const status = (): ServiceStatus => serviceStatus(store, embedder, mcpUrl);
  const routes = createRoutes({ store, secret, contextBudget, status, mcpUrl: () => mcpUrl });
  const mcp = createMcpHandler({
    secret,
    instructions: MCP_INSTRUCTIONS,
    serverVersion: SERVICE_VERSION,
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
  // The model loads after the server is listening; keyword search serves requests meanwhile.
  const embedderLoad = activateEmbedder({ store, embedder, options, log });

  return {
    store,
    port,
    mcpUrl,
    secret,
    status,
    embedderReady: () => embedderLoad,
    async stop() {
      clearInterval(pruneTimer);
      await server.stop(true);
      await embedderLoad;
      store.close();
    },
  };
}

function serviceStatus(store: MemoryStore, embedder: EmbedderStatus, mcpUrl: string): ServiceStatus {
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
    embedder: { ...embedder, pending: store.pendingEmbeddings() },
  };
}

// MCP callers carry only a project key; names come from the projects table when known.
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

type Handler = (req: Request) => Promise<Response>;

function serve(
  port: number,
  handlers: { mcp: Handler; internal: Handler; log: (m: string) => void },
): Server<undefined> {
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
      handlers.log(`request failed: ${errorText(error)}`);
      return Response.json({ error: "internal error" }, { status: 500 });
    },
  });
}

// POST /v1/<route>: loopback only, no browser origins, and the HMAC key derived from the secret.
function createInternalHandler(routes: Routes, key: string, log: (m: string) => void): Handler {
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
      log(`${route} failed: ${errorText(error)}`);
      return Response.json({ error: errorText(error) }, { status: 500 });
    }
  };
}

function rejectInternal(req: Request, expected: Buffer): Response | null {
  if (req.headers.get("origin")) return Response.json({ error: "origin not allowed" }, { status: 403 });
  const given = Buffer.from(req.headers.get(SERVICE_KEY_HEADER) ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return req.method === "POST" ? null : Response.json({ error: "method not allowed" }, { status: 405 });
}

function isRoute(name: string): name is ServiceRoute {
  return Object.hasOwn(serviceInputs, name);
}

function startPruning(store: MemoryStore, retentionDays: number, log: (m: string) => void): Timer {
  const prune = () => {
    try {
      const pruned = store.pruneSessions(retentionDays);
      if (pruned) log(`pruned ${pruned} old session digests`);
    } catch (error) {
      log(`prune failed: ${errorText(error)}`);
    }
  };
  prune();
  return setInterval(prune, PRUNE_INTERVAL_MS);
}

function activateEmbedder(input: {
  store: MemoryStore;
  embedder: EmbedderStatus;
  options: ServiceOptions;
  log: (m: string) => void;
}): Promise<void> {
  const { store, embedder, options, log } = input;
  const modelsDir = options.modelsDir ?? join(options.dataDir, "models");
  return (options.loadEmbedder ?? loadEmbedder)(options.tier, modelsDir).then(
    (loaded) => {
      store.setEmbedder(loaded);
      embedder.state = "ready";
      log(`embeddings ready: ${loaded.spec.model} (${loaded.spec.dims}d, tier ${options.tier})`);
    },
    (error: unknown) => {
      embedder.state = "error";
      embedder.error = errorText(error);
      log(`embeddings unavailable, keyword search only: ${errorText(error)}`);
    },
  );
}
