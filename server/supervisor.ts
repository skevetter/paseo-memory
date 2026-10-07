// Supervises the Bun memory service: finds bun and the service entry, spawns it with a clean
// environment, restarts it with backoff when it exits, and proxies internal API calls to it.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { MemoryStatus } from "../shared/contracts";
import {
  type EmbeddingTier,
  FATAL_EXIT_CODE,
  SERVICE_EVENT_PREFIX,
  SERVICE_KEY_HEADER,
  SERVICE_KEY_LABEL,
  type ServiceEvent,
  type ServiceInput,
  type ServiceOutputs,
  type ServiceRoute,
  type ServiceStatus,
} from "../shared/service-api";
import { findBun, type LocateEnv, realLocateEnv, resolveServicePath, type ServiceLocation } from "./locate";

export interface ServiceConfig {
  bunPath: string;
  servicePath: string;
  sqlitePath: string;
  tier: EmbeddingTier;
  port: number;
  contextBudgetChars: number;
  sessionRetentionDays: number;
}

export interface SupervisorOptions {
  dataDir: string;
  paseoHome: string;
  log: (message: string) => void;
  locateEnv?: LocateEnv;
}

type SupervisorState = MemoryStatus["service"]["state"];

const READY_TIMEOUT_MS = 20_000;
const FATAL_RETRY_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const HEALTHY_RUN_MS = 60_000;
const STOP_GRACE_MS = 3000;
// Electron's Node switch must not leak into bun; the rest of the daemon environment is kept.
const DROPPED_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "NODE_OPTIONS"];

export function ensureSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "mcp-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export function serviceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !DROPPED_ENV.includes(key)));
}

export function serviceArgs(
  config: ServiceConfig,
  input: { entry: string; dataDir: string; parentPid: number },
): string[] {
  const args = [
    input.entry,
    "--data-dir",
    input.dataDir,
    "--port",
    String(config.port),
    "--tier",
    config.tier,
  ];
  args.push("--context-budget", String(config.contextBudgetChars));
  args.push("--retention-days", String(config.sessionRetentionDays), "--parent-pid", String(input.parentPid));
  if (config.sqlitePath) args.push("--sqlite-path", config.sqlitePath);
  return args;
}

export class ServiceSupervisor {
  private readonly options: SupervisorOptions;
  private readonly key: string;
  private readonly sys: LocateEnv;
  private config: ServiceConfig | null = null;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: SupervisorState = "stopped";
  private detail: string | null = null;
  private bunPath: string | null = null;
  private bunVersion: string | null = null;
  private location: ServiceLocation | null = null;
  private live: ServiceStatus | null = null;
  private restarts = 0;
  private failures = 0;
  private startedAt = 0;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.sys = options.locateEnv ?? realLocateEnv;
    this.key = createHmac("sha256", ensureSecret(options.dataDir)).update(SERVICE_KEY_LABEL).digest("hex");
  }

  get running(): boolean {
    return this.state === "running" && this.live !== null;
  }

  // Applies a configuration; restarts the service only when it changed.
  async configure(config: ServiceConfig): Promise<void> {
    if (this.config && JSON.stringify(this.config) === JSON.stringify(config) && this.state !== "stopped")
      return;
    await this.stop();
    this.config = config;
    this.failures = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    this.clearTimer();
    this.state = "stopped";
    const child = this.child;
    this.child = null;
    this.live = null;
    if (child) await terminate(child);
  }

  async call<R extends ServiceRoute>(
    route: R,
    input: ServiceInput<R>,
    timeoutMs: number,
  ): Promise<ServiceOutputs[R]> {
    const port = this.live && this.state === "running" ? this.config?.port : undefined;
    if (!port) throw new Error(`memory service is ${this.state}${this.detail ? `: ${this.detail}` : ""}`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: this.key },
        body: JSON.stringify(input),
        signal: abort.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(`memory service ${route} failed (${response.status}): ${JSON.stringify(body)}`);
      // The service is our own authenticated child; RPC output schemas validate again downstream.
      const output = body as ServiceOutputs[R];
      return output;
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`memory service ${route} timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot(): MemoryStatus["service"] {
    return {
      state: this.state,
      detail: this.detail,
      bunPath: this.bunPath,
      bunVersion: this.bunVersion,
      servicePath: this.location?.entry ?? null,
      servicePathSource: this.location?.source ?? null,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
    };
  }

  lastStatus(): ServiceStatus | null {
    return this.live;
  }

  private launch(): void {
    this.clearTimer();
    const config = this.config;
    if (!config) return;
    try {
      this.bunPath = findBun(config.bunPath, this.sys);
      this.location = resolveServicePath(config.servicePath, this.options.paseoHome, this.sys);
    } catch (error) {
      this.markFatal(error instanceof Error ? error.message : String(error));
      return;
    }
    this.state = this.restarts > 0 ? "restarting" : "starting";
    void this.readBunVersion(this.bunPath);
    const args = serviceArgs(config, {
      entry: this.location.entry,
      dataDir: this.options.dataDir,
      parentPid: process.pid,
    });
    this.options.log(`starting service: ${this.bunPath} ${args.join(" ")}`);
    const child = spawn(this.bunPath, args, {
      cwd: this.location.root,
      env: serviceEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attach(child);
  }

  private attach(child: ChildProcess): void {
    this.child = child;
    this.live = null;
    this.startedAt = Date.now();
    if (child.stdout) forEachLine(child.stdout, (line) => this.onStdout(child, line));
    if (child.stderr) forEachLine(child.stderr, (line) => this.options.log(line));
    child.on("error", (error) => {
      this.options.log(`service process error: ${error.message}`);
      this.onExit(child, null);
    });
    child.on("exit", (code) => this.onExit(child, code));
    this.timer = setTimeout(() => {
      if (this.child !== child || this.live) return;
      this.options.log(`service did not report ready within ${READY_TIMEOUT_MS} ms; restarting`);
      child.kill("SIGKILL");
    }, READY_TIMEOUT_MS);
  }

  private onStdout(child: ChildProcess, line: string): void {
    if (!line.startsWith(SERVICE_EVENT_PREFIX)) {
      this.options.log(line);
      return;
    }
    let event: ServiceEvent;
    try {
      event = JSON.parse(line.slice(SERVICE_EVENT_PREFIX.length));
    } catch {
      this.options.log(`unparseable service event: ${line}`);
      return;
    }
    if (this.child !== child) return;
    if (event.event === "ready") {
      this.clearTimer();
      this.live = event.status;
      this.state = "running";
      this.detail = null;
    } else {
      this.detail = event.error;
    }
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.live = null;
    this.clearTimer();
    if (this.state === "stopped") return;
    if (code === FATAL_EXIT_CODE) {
      this.markFatal(this.detail ?? "service refused to start");
      return;
    }
    this.failures = Date.now() - this.startedAt > HEALTHY_RUN_MS ? 1 : this.failures + 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
    this.detail = `exited with code ${code ?? "signal"}; restarting in ${delay} ms`;
    this.options.log(`service ${this.detail}`);
    this.scheduleLaunch(delay, "restarting");
  }

  // Fatal causes (no bun, no SQLite build, sqlite-vec failure) need a fix on the host, so retry slowly.
  private markFatal(detail: string): void {
    this.detail = detail;
    this.options.log(`service unavailable: ${detail} (retrying in ${FATAL_RETRY_MS / 1000} s)`);
    this.scheduleLaunch(FATAL_RETRY_MS, "fatal");
  }

  private scheduleLaunch(delay: number, state: SupervisorState): void {
    this.state = state;
    this.timer = setTimeout(() => {
      this.restarts++;
      this.launch();
    }, delay);
  }

  private async readBunVersion(bunPath: string): Promise<void> {
    try {
      const { stdout } = await promisify(execFile)(bunPath, ["--version"], {
        env: serviceEnv(process.env),
        timeout: 5000,
      });
      this.bunVersion = stdout.trim();
    } catch (error) {
      this.bunVersion = null;
      this.options.log(`bun --version failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private clearTimer(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }
}

function forEachLine(stream: Readable, onLine: (line: string) => void): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  });
}

// SIGTERM lets the service close the database; SIGKILL after a grace period.
function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
  child.once("exit", () => {
    clearTimeout(kill);
    resolve();
  });
  child.stdin?.end();
  child.kill("SIGTERM");
  return promise;
}
