// Entry point: bun service/main.ts --data-dir <dir> --port <port> [--tier zero|low|medium|high]
//   [--rerank auto|on|off] [--sqlite-path <dylib>] [--models-dir <dir>] [--context-budget <chars>]
//   [--retention-days <n>] [--parent-pid <pid>]
// Info lines go to stdout and warnings and errors to stderr, each prefixed with its level. One
// SERVICE_EVENT_PREFIX line on stdout reports ready or fatal.

import { parseArgs } from "node:util";
import { createLogger } from "../shared/log";
import {
  EMBEDDING_TIERS,
  FATAL_EXIT_CODE,
  RERANK_MODES,
  SERVICE_EVENT_PREFIX,
  type ServiceEvent,
} from "../shared/service-api";
import { type RunningService, startService } from "./app";
import { errorText, FatalError } from "./sqlite";

const emit = (event: ServiceEvent) =>
  process.stdout.write(`${SERVICE_EVENT_PREFIX}${JSON.stringify(event)}\n`);
const log = createLogger("paseo-memory-service");

function fail(error: unknown): never {
  const message = errorText(error);
  log.error(`fatal: ${message}`);
  emit({ event: "fatal", error: message });
  process.exit(error instanceof FatalError ? FATAL_EXIT_CODE : 1);
}

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "6797" },
    tier: { type: "string", default: "medium" },
    rerank: { type: "string", default: "auto" },
    "sqlite-path": { type: "string" },
    "models-dir": { type: "string" },
    "context-budget": { type: "string", default: "6000" },
    "retention-days": { type: "string", default: "30" },
    "parent-pid": { type: "string" },
  },
  strict: true,
});

const dataDir = values["data-dir"];
if (!dataDir) fail(new FatalError("--data-dir is required"));
const tier = EMBEDDING_TIERS.find((t) => t === values.tier);
if (!tier) fail(new FatalError(`--tier must be one of ${EMBEDDING_TIERS.join(", ")}`));
const rerank = RERANK_MODES.find((m) => m === values.rerank);
if (!rerank) fail(new FatalError(`--rerank must be one of ${RERANK_MODES.join(", ")}`));

let service: RunningService;
try {
  service = await startService({
    dataDir,
    port: Number(values.port),
    tier,
    rerank,
    sqlitePath: values["sqlite-path"] || null,
    modelsDir: values["models-dir"] || undefined,
    contextBudgetChars: Number(values["context-budget"]),
    sessionRetentionDays: Number(values["retention-days"]),
    log,
  });
} catch (error) {
  fail(error);
}

const status = service.status();
log.info(
  `listening on 127.0.0.1:${service.port} (bun ${status.bunVersion}, sqlite ${status.sqliteVersion}` +
    `${status.sqliteLibrary ? ` from ${status.sqliteLibrary}` : ""}, sqlite-vec ${status.sqliteVecVersion}, ` +
    `tier ${tier}${status.embedder.model ? ` ${status.embedder.model}` : ""}, re-rank ${rerank}, db ${status.dbPath})`,
);
emit({ event: "ready", port: service.port, status });

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`stopping (${reason})`);
  const force = setTimeout(() => process.exit(0), 5000);
  try {
    await service.stop();
  } catch (error) {
    log.warn(`shutdown error: ${errorText(error)}`);
  }
  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Under a supervisor (--parent-pid), exit when it goes away instead of orphaning the port:
// stdin EOF reports a clean exit at once, the pid poll covers a SIGKILLed parent.
const parentPid = Number(values["parent-pid"] ?? 0);
if (parentPid > 0) {
  process.stdin.on("end", () => void shutdown("supervisor closed stdin"));
  process.stdin.on("error", () => void shutdown("supervisor stdin error"));
  process.stdin.resume();
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void shutdown(`parent ${parentPid} exited`);
    }
  }, 2000);
}
