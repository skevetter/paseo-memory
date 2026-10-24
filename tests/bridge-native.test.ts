import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { Tokenizer } from "@huggingface/tokenizers";
import { BRIDGE_DISCOVERY_FILE, BridgeDiscoverySchema } from "../server/bridge-discovery";
import type { PaseoApi } from "../server/host-types";
import { contributeServer } from "../server/plugin";
import { ServiceSupervisor } from "../server/supervisor";
import { type RunningService, serviceKey, startService } from "../service/app";
import {
  BRIDGE_BOOTSTRAP_ENV,
  BRIDGE_MANAGED_REGISTRY,
  type BridgeSessionResult,
  BridgeSessionResultSchema,
  DEFAULT_BRIDGE_SETTINGS,
  ManagedAgentRegistrySchema,
} from "../shared/bridge";
import { type MemorySettings, memorySettings, runtimeConfig } from "../shared/contracts";
import { silentLogger } from "../shared/log";
import {
  NONCE_ENV,
  SERVICE_KEY_HEADER,
  type ServiceInput,
  type ServiceOutputs,
  type ServiceRoute,
} from "../shared/service-api";
import { hashEmbedder } from "./helpers";

// Native hook fixtures. Only process launch is stubbed; every RPC crosses the real private HTTP route.
// nativeHostProven:false; controlled registered callbacks are not physical host ordering proof.

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type CapturedHook = (input: unknown, context: PluginHookContext) => unknown;

const encoder = new Tokenizer(
  {
    version: "1.0",
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: "WhitespaceSplit" },
    post_processor: null,
    decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, release: 1, policy: 2 }, unk_token: "[UNK]" },
  },
  { unk_token: "[UNK]" },
);
const tokenizer = {
  id: "fixture/native-wordlevel",
  count: (text: string) => encoder.encode(text, { add_special_tokens: false }).ids.length,
};
const envKeys = ["PASEO_HOME", "PASEO_MEMORY_DIR"] as const;
const hosts: Array<{ dispose(): Promise<void> }> = [];
const timerRestorers: Array<() => void> = [];
let savedEnv: Record<(typeof envKeys)[number], string | undefined>;
let service: RunningService | undefined;
let dataDir: string;

const WORK = { kind: "bot", botId: "work" } as const;
const CONSUMER = { id: "bots", readNamespaces: [WORK], writeNamespaces: [WORK] };
const OWNERSHIP = {
  contextOwner: "paseo-bots",
  captureOwner: "paseo-bots",
  reviewOwner: "paseo-bots",
} as const;
const IDLE_REVIEW = { reviewTrigger: "idle", reviewIdleMinutes: 1 } as const;
const CALLER_PROMPT = "Caller system prompt, verbatim.";
const CALLER_MCP = { unrelated: { type: "http", url: "http://127.0.0.1:9/other", headers: {} } };
const CALLER_ENV = { KEEP_ME: "1" };

const SessionSchema = BridgeSessionResultSchema;
const DiscoverySchema = BridgeDiscoverySchema;

type SessionResult = BridgeSessionResult;

function live(): RunningService {
  if (!service) throw new Error("Native bridge service was not started");
  return service;
}

async function launch(): Promise<RunningService> {
  const running = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    contextTokenizers: new Map([["omp", tokenizer]]),
    log: silentLogger,
  });
  await running.modelsReady();
  return running;
}

async function post(
  route: string,
  body: unknown,
  authenticated = true,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${live().port}/v1/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { [SERVICE_KEY_HEADER]: serviceKey(live().secret) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function discovery() {
  return DiscoverySchema.parse(JSON.parse(readFileSync(join(dataDir, BRIDGE_DISCOVERY_FILE), "utf8")));
}

// Controller-owned register and bind. This is the only path that makes a credential active.
async function controllerCall(body: unknown) {
  const descriptor = discovery();
  const response = await fetch(`${descriptor.endpoint}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${controllerToken()}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

// The discovery file names the credential file; the bearer is the `credential` field inside it.
function controllerToken(): string {
  const descriptor = discovery();
  const controller = descriptor.controllers[0];
  if (!controller) throw new Error("Discovery descriptor has no controller");
  const file = JSON.parse(readFileSync(join(dataDir, controller.credentialRef), "utf8")) as {
    credential: string;
  };
  return file.credential;
}

// Forward every plugin supervisor RPC to the actual service. Only the process launch is disabled.
function nativeTransport() {
  const configured = Promise.withResolvers<void>();
  const calls: ServiceRoute[] = [];
  const outputs = new Map<ServiceRoute, unknown[]>();
  const failures = new Set<ServiceRoute>();
  const pending = new Set<Promise<unknown>>();

  async function forward<R extends ServiceRoute>(
    route: R,
    input: ServiceInput<R>,
  ): Promise<ServiceOutputs[R]> {
    calls.push(route);
    if (failures.has(route)) throw new Error(`Controlled ${route} transport failure`);
    const response = await post(route, input);
    if (response.status !== 200)
      throw new Error(`${route} failed (${response.status}): ${JSON.stringify(response.body)}`);
    outputs.set(route, [...(outputs.get(route) ?? []), response.body]);
    return response.body as ServiceOutputs[R];
  }
  function call<R extends ServiceRoute>(route: R, input: ServiceInput<R>): Promise<ServiceOutputs[R]> {
    const work = forward(route, input);
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  const configure = spyOn(ServiceSupervisor.prototype, "configure").mockImplementation(async () => {
    configured.resolve();
  });
  const rpc = spyOn(ServiceSupervisor.prototype, "call").mockImplementation(call);
  return {
    configured: configured.promise,
    calls,
    outputs,
    failures,
    count: (route: ServiceRoute) => calls.filter((name) => name === route).length,
    last: <R extends ServiceRoute>(route: R): ServiceOutputs[R] | undefined => {
      const list = outputs.get(route);
      return list?.at(-1) as ServiceOutputs[R] | undefined;
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    restore() {
      rpc.mockRestore();
      configure.mockRestore();
    },
  };
}

// Captures the hooks that contributeServer registers, so the test invokes the real registered callbacks.
function capturedServer(settings: MemorySettings) {
  const hooks: Record<string, CapturedHook> = {};
  const register = (name: string, handler: CapturedHook) => {
    hooks[name] = handler;
    return () => {
      delete hooks[name];
    };
  };
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: settings }),
      subscribe: () => () => undefined,
    }),
    before: register,
    on: register,
    handle: () => undefined,
  } as unknown as Parameters<typeof contributeServer>[0];
  return { server, hooks };
}

async function nativeHost(overrides: Partial<MemorySettings> = {}, paseo?: PaseoApi) {
  const settings = memorySettings.schema.parse({
    autoCapture: false,
    reviewTrigger: "off",
    injectContext: true,
    bridge: { enabled: true, consumers: [CONSUMER] },
    injectMcp: true,
    ...overrides,
  });
  const registration = capturedServer(settings);
  const transport = nativeTransport();
  const cleanup = contributeServer(registration.server);
  await transport.configured;
  const context: PluginHookContext = {
    paseo:
      paseo ??
      ({
        workspaces: {
          list: async () => ({
            entries: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          }),
        },
        projects: { list: async () => ({ projects: [] }) },
      } as unknown as PaseoApi),
    signal: new AbortController().signal,
  };
  let disposed = false;
  const host = {
    transport,
    async invoke(name: string, input: unknown): Promise<unknown> {
      const hook = registration.hooks[name];
      if (!hook) throw new Error(`Native hook ${name} was not registered`);
      return hook(input, context);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await transport.drain();
        await cleanup();
      } finally {
        transport.restore();
      }
    },
  };
  hosts.push(host);
  return host;
}

// Timer handles remain real, but deadline callbacks run only when this fixture advances them.
function manualDeadlines() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  if (!setDescriptor || !clearDescriptor) throw new Error("Native timers have no own descriptors");
  const pending = new Map<unknown, { fire(): void; cancel(): void }>();
  function controlledTimeout<Args extends unknown[]>(
    callback: (...args: Args) => void,
    _delay?: number,
    ...args: Args
  ): Timer {
    const handle = set(() => undefined, 86_400_000);
    handle.unref();
    pending.set(handle, { fire: () => callback(...args), cancel: () => clear(Number(handle)) });
    return handle;
  }
  Object.defineProperty(globalThis, "setTimeout", {
    ...setDescriptor,
    value: Object.assign(controlledTimeout, { __promisify__: set.__promisify__ }),
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    ...clearDescriptor,
    value: (handle?: Timer | NodeJS.Timeout | string | number) => {
      pending.delete(handle);
      clear(typeof handle === "object" ? Number(handle) : handle);
    },
  });
  const restore = () => {
    for (const timer of pending.values()) timer.cancel();
    pending.clear();
    Object.defineProperty(globalThis, "setTimeout", setDescriptor);
    Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
  };
  timerRestorers.push(restore);
  return {
    expire() {
      const timer = pending.values().next().value;
      if (!timer) throw new Error("No pending native deadline");
      timer.fire();
    },
    count: () => pending.size,
  };
}

function ended(agentId: string, cwd: string, turnId: string | null = "turn-1"): TurnEnded {
  return {
    agent: {
      id: agentId,
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd,
      title: "Native session",
    },
    turnId,
    outcome: { kind: "completed" },
    timeline: [
      { type: "user_message", text: "Verify the release policy." },
      { type: "assistant_message", text: "Verified the policy." },
    ],
  };
}

// Registers a controller-owned bootstrap ref; the ref is non-authorizing until bind.
async function registerBootstrap(
  agentId: string,
  cwd: string,
): Promise<SessionResult & { bootstrapRef: string }> {
  const registered = await controllerCall({
    protocolVersion: 1,
    requestId: `register-${agentId}`,
    action: "register",
    botId: "bot-native",
    runId: `run-${agentId}`,
    cycleId: "cycle-1",
    attemptId: "attempt-1",
    executionId: `exec-${agentId}`,
    sessionEpoch: 1,
    agentId,
    providerTurnId: null,
    purpose: "task",
    expectedIdentity: { workspaceId: null, provider: "omp", cwd },
    requestedNamespaces: [WORK],
    ownership: OWNERSHIP,
  });
  expect(registered.status).toBe(200);
  const result = SessionSchema.parse(registered.body);
  if (!result.bootstrapRef) throw new Error("A pending registration must issue a bootstrap reference.");
  return { ...result, bootstrapRef: result.bootstrapRef };
}

// Controller-owned bind. Requires the managed create to have been observed under the pending lease.
async function bindSession(session: SessionResult, agentId: string, cwd: string) {
  return controllerCall({
    protocolVersion: 1,
    requestId: `bind-${agentId}`,
    action: "bind",
    sessionId: session.sessionId,
    leaseVersion: 1,
    actualAgentId: agentId,
    observedIdentity: { workspaceId: null, provider: "omp", cwd },
    sessionEpoch: 1,
    bootstrapRef: session.bootstrapRef,
  });
}

// Hook input for agent.create: `{ request: { config, env? } }`.
function createInput(cwd: string, bootstrapRef: string | null) {
  const env: Record<string, string> = { ...CALLER_ENV };
  if (bootstrapRef) env[BRIDGE_BOOTSTRAP_ENV] = bootstrapRef;
  return {
    request: {
      config: { provider: "omp", cwd, systemPrompt: CALLER_PROMPT, mcpServers: { ...CALLER_MCP } },
      env,
    },
  };
}

function registryAgentIds(): string[] {
  const path = join(dataDir, BRIDGE_MANAGED_REGISTRY);
  return existsSync(path)
    ? ManagedAgentRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8"))).agentIds
    : [];
}

async function configureBridge(overrides: Partial<MemorySettings> = {}) {
  const settings = memorySettings.schema.parse({
    bridge: { enabled: true, consumers: [CONSUMER] },
    ...overrides,
  });
  const response = await post("configure", runtimeConfig(settings));
  expect(response.status).toBe(200);
  return settings;
}

beforeEach(async () => {
  savedEnv = { PASEO_HOME: process.env.PASEO_HOME, PASEO_MEMORY_DIR: process.env.PASEO_MEMORY_DIR };
  dataDir = mkdtempSync(join(tmpdir(), "bridge-native-"));
  process.env.PASEO_HOME = dataDir;
  process.env.PASEO_MEMORY_DIR = dataDir;
  service = await launch();
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const restore of timerRestorers.splice(0)) restore();
  if (service) await service.stop();
  service = undefined;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("native managed create", () => {
  it("preserves caller prompt, unrelated MCP servers, and env, and drops NONCE and every authority token", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-a");
    const session = await registerBootstrap("agent-create", cwd);
    const host = await nativeHost();

    const output = (await host.invoke("agent.create", createInput(cwd, session.bootstrapRef))) as {
      config: { systemPrompt?: string; mcpServers?: Record<string, unknown> };
      env?: Record<string, string>;
    };

    expect(output.config.systemPrompt?.startsWith(CALLER_PROMPT)).toBe(true);
    expect(output.config.mcpServers?.unrelated).toEqual(CALLER_MCP.unrelated);
    expect(output.env?.KEEP_ME).toBe("1");
    expect(output.env?.[BRIDGE_BOOTSTRAP_ENV]).toBe(session.bootstrapRef);
    expect(output.env?.[NONCE_ENV]).toBeUndefined();

    const created = host.transport.last("bridge-create");
    expect(created?.nonce).toEqual(expect.any(String));
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(session.sessionToken);
    expect(serialized).not.toContain(controllerToken());
    expect(serialized).not.toContain(created?.nonce ?? "");
  });

  it("keeps the credential inert before bind and active only after an authenticated controlled bind", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-bind");
    const session = await registerBootstrap("agent-bind", cwd);
    const host = await nativeHost();
    await host.invoke("agent.create", createInput(cwd, session.bootstrapRef));

    const created = host.transport.last("bridge-create");
    if (!created) throw new Error("bridge-create was not forwarded to the service");
    const mcp = async () =>
      fetch(created.mcpServer.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...created.mcpServer.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

    // Pending lease: authenticatedTool denies (scope_denied, 403) until bind activates the tool token.
    expect((await mcp()).status).toBe(403);

    const bound = await bindSession(session, "agent-bind", cwd);
    expect(bound.status).toBe(200);
    expect(SessionSchema.parse(bound.body).leaseVersion).toBe(2);

    expect((await mcp()).status).toBe(200);
  });
});

describe("native create gates fail closed", () => {
  it("rejects a managed create when bridge-create transport fails instead of returning the request", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-fail");
    const session = await registerBootstrap("agent-fail", cwd);
    const host = await nativeHost();
    host.transport.failures.add("bridge-create");

    await expect(host.invoke("agent.create", createInput(cwd, session.bootstrapRef))).rejects.toThrow(
      /Controlled bridge-create transport failure/,
    );
    expect(registryAgentIds()).toContain("agent-fail");
    expect((await bindSession(session, "agent-fail", cwd)).status).toBe(409);
  });

  it("rejects a managed create with an unknown bootstrap ref at the service", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-invalid");
    const host = await nativeHost();

    await expect(host.invoke("agent.create", createInput(cwd, "bogus-bootstrap-ref"))).rejects.toThrow(
      /bridge-create failed \(409\)/,
    );
    expect(host.transport.count("bridge-create")).toBe(1);
    expect(registryAgentIds()).not.toContain("agent-invalid");
  });

  it("preserves the standalone request when optional ordinary injection is unavailable", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-open");
    const host = await nativeHost();
    await live().stop();
    service = undefined;

    const input = createInput(cwd, null);
    const output = await host.invoke("agent.create", input);
    expect(output).toBe(input.request);
    expect(host.transport.count("bridge-create")).toBe(0);
    expect(host.transport.count("agent-context")).toBe(1);
  });
});

describe("concurrent same-cwd origins", () => {
  it("does not heuristic-match a second same-cwd agent to the first managed claim", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-shared");
    const first = await registerBootstrap("agent-first", cwd);
    const host = await nativeHost();
    await host.invoke("agent.create", createInput(cwd, first.bootstrapRef));
    expect(registryAgentIds()).toContain("agent-first");

    const second = {
      id: "agent-second",
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd,
      title: "Peer",
    };
    await host.invoke("agent.created", { agent: second });

    expect(registryAgentIds()).not.toContain("agent-second");
    expect(host.transport.count("bridge-open")).toBe(0);
  });
});

describe("history and stopped service", () => {
  it("makes no RPC for a history session even with the service stopped, and strips the bootstrap ref", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-history");
    const session = await registerBootstrap("agent-history", cwd);
    const host = await nativeHost();
    await host.invoke("agent.create", createInput(cwd, session.bootstrapRef));
    await live().stop();
    service = undefined;
    const callsBefore = host.transport.calls.length;

    const output = await host.invoke("agent.session_open", {
      request: {
        agentId: "agent-history",
        workspaceId: null,
        provider: "omp",
        cwd,
        reason: "resume",
        purpose: "history",
        env: { [BRIDGE_BOOTSTRAP_ENV]: session.bootstrapRef },
      },
    });

    expect(host.transport.calls.slice(callsBefore)).toEqual([]);
    expect(JSON.stringify(output) ?? "").not.toContain(session.bootstrapRef);
  });
});

describe("durable managed claims", () => {
  it("suppresses native review for a durable claim after hook reload while an ordinary agent still schedules review", async () => {
    await configureBridge(IDLE_REVIEW);
    const cwd = join(dataDir, "work-durable");
    const session = await registerBootstrap("agent-durable", cwd);
    const first = await nativeHost(IDLE_REVIEW);
    await first.invoke("agent.create", createInput(cwd, session.bootstrapRef));
    await first.dispose();

    const reloaded = await nativeHost(IDLE_REVIEW);
    const timers = manualDeadlines();
    await reloaded.invoke("agent.turn_ended", ended("agent-durable", cwd));
    expect(timers.count()).toBe(0);

    await reloaded.invoke("agent.turn_ended", ended("ordinary-agent", cwd, "turn-2"));
    await reloaded.invoke("agent.turn_ended", ended("ordinary-agent", cwd, "turn-3"));
    expect(timers.count()).toBe(1);
    timers.expire();
    await reloaded.transport.drain();
    expect(reloaded.transport.count("review-skip")).toBe(1);
    expect(reloaded.transport.count("review-start")).toBe(0);
  });

  it("keeps the registry claim after the owner disables the bridge and still suppresses native review for that agent", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-disabled");
    const session = await registerBootstrap("agent-disabled", cwd);
    const host = await nativeHost(IDLE_REVIEW);
    await host.invoke("agent.create", createInput(cwd, session.bootstrapRef));
    expect(registryAgentIds()).toContain("agent-disabled");
    await host.dispose();

    await configureBridge({ bridge: { ...DEFAULT_BRIDGE_SETTINGS, enabled: false } });
    const disabled = await nativeHost({
      ...IDLE_REVIEW,
      bridge: { ...DEFAULT_BRIDGE_SETTINGS, enabled: false },
    });
    const timers = manualDeadlines();
    await disabled.invoke("agent.turn_ended", ended("agent-disabled", cwd));
    expect(timers.count()).toBe(0);

    await disabled.invoke("agent.turn_ended", ended("ordinary-agent", cwd, "turn-2"));
    await disabled.invoke("agent.turn_ended", ended("ordinary-agent", cwd, "turn-3"));
    expect(timers.count()).toBe(1);
    expect(registryAgentIds()).toContain("agent-disabled");
  });
});

// Resume of a bound managed execution fails closed with unsupported_version; it never opens a bridge under the prior epoch.
describe("unsupported resume rotation", () => {
  it("rejects a resume of a bound managed execution with unsupported_version and starts no new bridge-create", async () => {
    await configureBridge();
    const cwd = join(dataDir, "work-resume");
    const session = await registerBootstrap("agent-resume", cwd);
    const host = await nativeHost();
    await host.invoke("agent.create", createInput(cwd, session.bootstrapRef));
    const bound = await bindSession(session, "agent-resume", cwd);
    expect(bound.status).toBe(200);

    await expect(
      host.invoke("agent.session_open", {
        request: {
          agentId: "agent-resume",
          workspaceId: null,
          provider: "omp",
          cwd,
          reason: "resume",
          purpose: "interactive",
          env: {},
        },
      }),
    ).rejects.toThrow(/unsupported_version/);

    expect(host.transport.count("bridge-open")).toBe(1);
    expect(host.transport.count("bridge-create")).toBe(1);
  });
});
