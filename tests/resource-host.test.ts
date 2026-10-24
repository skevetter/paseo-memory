import { afterEach, beforeEach, expect, it, setSystemTime, spyOn } from "bun:test";
import type {
  PluginBeforeRequests,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { Tokenizer } from "@huggingface/tokenizers";
import { z } from "zod";
import type { PaseoApi } from "../server/host-types";
import { contributeServer } from "../server/plugin";
import { ServiceSupervisor } from "../server/supervisor";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { type MemorySettings, memorySettings } from "../shared/contracts";
import { MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { ResourceStatusSchema } from "../shared/resources";
import { RetrievalResultSchema } from "../shared/retrieval";
import { reviewPrompt } from "../shared/review";
import {
  NONCE_ENV,
  SERVICE_KEY_HEADER,
  type ServiceInput,
  type ServiceOutputs,
  type ServiceRoute,
} from "../shared/service-api";
import { dataRepo, hashEmbedder, tempDir } from "./helpers";

type CreateRequest = PluginBeforeRequests["agent.create"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type CapturedHook = (input: unknown, context: PluginHookContext) => unknown;

const AgentContextSchema = z.object({
  context: RetrievalResultSchema.nullable(),
  mcpServer: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }).nullable(),
  nonce: z.string().nullable(),
});
const HookOutputSchema = z.object({
  config: z.object({ systemPrompt: z.string().optional() }).passthrough(),
  env: z.record(z.string(), z.string()).optional(),
});
const ReceiptSchema = z.object({ recorded: z.boolean(), duplicate: z.boolean() });
const StatusSchema = z.object({ resources: ResourceStatusSchema });
const McpResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.object({ retrieval: RetrievalResultSchema.omit({ contextText: true }) }),
  }),
});
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
  id: "fixture/host-wordlevel",
  count: (text: string) => encoder.encode(text, { add_special_tokens: false }).ids.length,
};
const envKeys = ["PASEO_HOME", "PASEO_MEMORY_DIR"] as const;
const hosts: Array<{ dispose(): Promise<void> }> = [];
const timerRestorers: Array<() => void> = [];
let savedEnv: Record<(typeof envKeys)[number], string | undefined>;
let service: RunningService | undefined;
let dataDir: string;

function live(): RunningService {
  if (!service) throw new Error("Host resource service was not started");
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

beforeEach(async () => {
  savedEnv = { PASEO_HOME: process.env.PASEO_HOME, PASEO_MEMORY_DIR: process.env.PASEO_MEMORY_DIR };
  dataDir = tempDir("pm-resource-host-");
  process.env.PASEO_HOME = dataDir;
  process.env.PASEO_MEMORY_DIR = dataDir;
  service = await launch();
});

afterEach(async () => {
  try {
    for (const host of hosts.splice(0).reverse()) await host.dispose();
  } finally {
    try {
      await service?.stop();
    } finally {
      service = undefined;
      for (const restore of timerRestorers.splice(0).reverse()) restore();
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      setSystemTime();
    }
  }
});

async function post(route: string, body: unknown, authenticated = true) {
  const running = live();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers[SERVICE_KEY_HEADER] = serviceKey(running.secret);
  const response = await fetch(`http://127.0.0.1:${running.port}/v1/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function usage() {
  const response = await post("status", {});
  expect(response.status).toBe(200);
  return StatusSchema.parse(response.body).resources.usage;
}

async function seed() {
  const artifact = await post("evidence-artifact", {
    sourceRef: "artifact:host-release-policy",
    content: "Release policy requires independently observed rollout verification.",
    scope: "global",
    projectKey: null,
    allowExcerpt: true,
  });
  expect(artifact.status).toBe(200);
  const source = z.object({ sourceRef: z.string(), sourceHash: z.string() }).parse(artifact.body);
  const created = await post("mutate", {
    requestId: "host-release-policy",
    operation: "create",
    evidence: [{ sourceKind: "artifact", ...source }],
    change: {
      title: "Release policy",
      content: "Release policy requires independently observed rollout verification.",
      scope: "global",
      state: "active",
      pinned: true,
    },
  });
  expect(created.status).toBe(200);
  return MutationResultSchema.parse(created.body).memoryRef;
}

async function issuedContext(provider = "omp") {
  const response = await post("agent-context", {
    project: null,
    provider,
    includeContext: true,
    includeTools: false,
    taskBudgetMs: 1000,
    assemblyPrefix: "Preserve these caller instructions.",
  });
  expect(response.status).toBe(200);
  const issued = AgentContextSchema.parse(response.body);
  if (!issued.context || !issued.nonce) throw new Error("Expected an issued agent-create fragment");
  return { context: issued.context, nonce: issued.nonce };
}

function capturedServer(settings: MemorySettings) {
  const hooks: Record<string, CapturedHook | undefined> = {};
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
  } as unknown as PluginServerContext;
  return { server, hooks };
}

// Only process launch is suppressed. Every successful plugin RPC crosses the actual private HTTP route.
function nativeTransport() {
  const configured = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<ServiceOutputs["agent-context"]>();
  const release = Promise.withResolvers<void>();
  const admissionReady = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  const pending = new Set<Promise<unknown>>();
  const failures = new Set<ServiceRoute>();
  const faulted = new Set<ServiceRoute>();
  const contexts: ServiceOutputs["agent-context"][] = [];
  const held = new Map<ServiceRoute, Promise<void>>();
  async function forward<R extends ServiceRoute>(
    route: R,
    input: ServiceInput<R>,
  ): Promise<ServiceOutputs[R]> {
    if (failures.has(route)) {
      faulted.add(route);
      throw new Error(`Controlled ${route} transport failure`);
    }
    const response = await post(route, input);
    if (response.status !== 200)
      throw new Error(`${route} failed (${response.status}): ${JSON.stringify(response.body)}`);
    if (route === "agent-context") {
      const issued = AgentContextSchema.parse(response.body);
      contexts.push(issued);
      ready.resolve(issued);
    }
    if (route === "context-admit") admissionReady.resolve();
    await held.get(route);
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
    ready: ready.promise,
    admissionReady: admissionReady.promise,
    contexts,
    failures,
    faulted,
    hold: () => {
      held.set("agent-context", release.promise);
    },
    holdAdmission: () => {
      held.set("context-admit", releaseAdmission.promise);
    },
    release: () => {
      release.resolve();
      releaseAdmission.resolve();
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

async function nativeHost(overrides: Partial<MemorySettings> = {}) {
  const settings = memorySettings.schema.parse({
    autoCapture: false,
    reviewTrigger: "off",
    injectContext: true,
    injectMcp: false,
    ...overrides,
  });
  const registration = capturedServer(settings);
  const transport = nativeTransport();
  const cleanup = contributeServer(registration.server);
  await transport.configured;
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }),
    },
    projects: { list: async () => ({ projects: [] }) },
  } as unknown as PaseoApi;
  const context: PluginHookContext = { paseo, signal: new AbortController().signal };
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
      transport.release();
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

function ended(
  turnId: string | null,
  outcome: TurnEnded["outcome"] = { kind: "completed" },
  agentId = "host-agent",
): TurnEnded {
  return {
    agent: {
      id: agentId,
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd: dataDir,
      title: "Host session",
    },
    turnId,
    outcome,
    timeline: [
      { type: "user_message", text: "Verify the release policy." },
      {
        type: "assistant_message",
        text: "Verified the policy. Claimed model billing: 999 USD and 50000 tokens.",
      },
    ],
  };
}

// Timer handles remain real, but deadline callbacks run only when this control fixture advances them.
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
  };
}

it("settles issued fragments in their original ledger attempt without duplicating local or estimated tokens", async () => {
  await seed();
  const exact = await issuedContext();
  const estimated = await issuedContext("unconfigured-tokenizer");
  const before = (await usage()).memoryInput;
  expect(before).toMatchObject({
    attempts: 2,
    prepared: 2,
    inputTokens: {
      providerObserved: null,
      localExact: exact.context.usage.tokenCount,
      estimated: estimated.context.usage.tokenCount,
    },
    observedCosts: [],
    unavailableBillingAttempts: 2,
  });
  const attached = { retrievalId: exact.context.retrievalId, nonce: exact.nonce, status: "attached" };
  const discarded = {
    retrievalId: estimated.context.retrievalId,
    nonce: estimated.nonce,
    status: "discarded",
  };
  expect(ReceiptSchema.parse((await post("context-settle", attached)).body)).toEqual({
    recorded: true,
    duplicate: false,
  });
  expect(ReceiptSchema.parse((await post("context-settle", discarded)).body)).toEqual({
    recorded: true,
    duplicate: false,
  });
  expect(ReceiptSchema.parse((await post("context-settle", attached)).body)).toEqual({
    recorded: true,
    duplicate: true,
  });
  const conflict = await post("context-settle", { ...attached, status: "discarded" });
  expect(conflict.status).toBe(409);
  expect(conflict.body).toMatchObject({ error: { code: "request_conflict" } });
  const after = (await usage()).memoryInput;
  expect(after).toMatchObject({ attempts: 2, prepared: 0, attached: 1, discarded: 1 });
  expect(after.inputTokens).toEqual(before.inputTokens);
  expect(after.localExactAttempts).toBe(1);
  expect(after.estimatedAttempts).toBe(1);
  expect(after.observedCosts).toEqual([]);
  const running = live();
  service = undefined;
  await running.stop();
  service = await launch();
  expect((await usage()).memoryInput).toEqual(after);
  expect(ReceiptSchema.parse((await post("context-settle", attached)).body).duplicate).toBe(true);
});

it("rejects invented settlements, forged metrics and MCP-only retrieval acknowledgements", async () => {
  const memory = await seed();
  const issued = await issuedContext();
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce, status: "attached" };
  expect((await post("context-settle", input, false)).status).toBe(401);
  for (const unknown of [
    { ...input, retrievalId: "never-issued" },
    { ...input, nonce: "foreign-nonce" },
  ]) {
    const response = await post("context-settle", unknown);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "context_invalidated" } });
  }
  for (const forged of [
    { ...input, producerId: "memory_runtime" },
    { ...input, inputTokens: 999 },
    { ...input, provenance: "provider_observed" },
    { ...input, sourceSequence: 1 },
  ])
    expect((await post("context-settle", forged)).status).toBe(400);
  const running = live();
  const response = await fetch(running.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(running.secret, {
        projectKey: null,
        agentId: "mcp-reader",
        provider: "omp",
        nonce: "mcp-only",
      }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mcp-only",
      method: "tools/call",
      params: { name: "memory_get", arguments: { ids: [memory.id] } },
    }),
  });
  expect(response.status).toBe(200);
  const result = McpResultSchema.parse(await response.json()).result;
  expect(result.isError).not.toBe(true);
  const mcpSettlement = await post("context-settle", {
    retrievalId: result.structuredContent.retrieval.retrievalId,
    nonce: "mcp-only",
    status: "attached",
  });
  expect(mcpSettlement.status).toBe(409);
  const mcpAdmission = await post("context-admit", {
    retrievalId: result.structuredContent.retrieval.retrievalId,
    nonce: "mcp-only",
  });
  expect(mcpAdmission.status).toBe(409);
  const totals = (await usage()).memoryInput;
  expect(totals).toMatchObject({ attempts: 2, prepared: 2, attached: 0, discarded: 0 });
});

it("acknowledges only the actual appended native create-hook output and preserves the caller prompt", async () => {
  await seed();
  const host = await nativeHost();
  const request: CreateRequest = {
    config: { provider: "omp", cwd: dataDir, systemPrompt: "Caller instructions remain authoritative." },
  };
  const result = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  expect(result.config.systemPrompt).toStartWith(`${request.config.systemPrompt}\n\n`);
  expect(result.config.systemPrompt).toContain("independently observed rollout verification");
  await host.transport.drain();
  const issued = host.transport.contexts[0];
  if (!issued?.context || !issued.nonce) throw new Error("Native hook did not receive issued context");
  const totals = (await usage()).memoryInput;
  expect(totals).toMatchObject({
    attempts: 1,
    prepared: 0,
    attached: 1,
    discarded: 0,
    inputTokens: { providerObserved: null, localExact: issued.context.usage.tokenCount, estimated: null },
    observedCosts: [],
    unavailableBillingAttempts: 1,
  });
  const replay = await post("context-settle", {
    retrievalId: issued.context.retrievalId,
    nonce: issued.nonce,
    status: "attached",
  });
  expect(ReceiptSchema.parse(replay.body)).toEqual({ recorded: true, duplicate: true });
  expect((await usage()).providerTurns.attempts).toBe(0);
});

it("does not lose an assembled native prompt when settlement telemetry fails", async () => {
  await seed();
  const host = await nativeHost();
  host.transport.failures.add("context-settle");
  const request: CreateRequest = {
    config: { provider: "omp", cwd: dataDir, systemPrompt: "Keep caller instructions." },
  };
  const output = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  await host.transport.drain();
  expect(output.config.systemPrompt).toStartWith("Keep caller instructions.\n\n");
  expect(output.config.systemPrompt).toContain("independently observed rollout verification");
  expect(host.transport.faulted.has("context-settle")).toBe(true);
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 1, attached: 0, discarded: 0 });
});

it("discards an empty native fragment instead of claiming it was appended", async () => {
  const host = await nativeHost();
  const request: CreateRequest = { config: { provider: "omp", cwd: dataDir, systemPrompt: "Caller only." } };
  const output = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  await host.transport.drain();
  expect(output.config.systemPrompt).toBe("Caller only.");
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 0, attached: 0, discarded: 1 });
});

it("discards a prepared context arriving after the native create deadline without late prompt attachment", async () => {
  await seed();
  const host = await nativeHost();
  host.transport.hold();
  const deadlines = manualDeadlines();
  const request: CreateRequest = {
    config: { provider: "omp", cwd: dataDir, systemPrompt: "Original output." },
  };
  const output = host.invoke("agent.create", { request });
  const issued = await host.transport.ready;
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 1 });
  deadlines.expire();
  expect(await output).toBe(request);
  host.transport.release();
  await host.transport.drain();
  if (!issued.context) throw new Error("Expected late prepared context");
  expect((await usage()).memoryInput).toMatchObject({
    attempts: 1,
    prepared: 0,
    attached: 0,
    discarded: 1,
    inputTokens: { localExact: issued.context.usage.tokenCount },
  });
});

it("records native completed, failed, canceled and review turns with billing unknown even when capture is disabled", async () => {
  const host = await nativeHost();
  const completed = ended("native-completed");
  await host.invoke("agent.turn_ended", completed);
  await host.invoke("agent.turn_ended", completed);
  await host.invoke(
    "agent.turn_ended",
    ended("native-failed", { kind: "failed", error: { message: "Provider failed" } }),
  );
  await host.invoke(
    "agent.turn_ended",
    ended("native-canceled", { kind: "canceled", reason: "Owner canceled" }),
  );
  await host.invoke("agent.turn_ended", { ...ended("empty-completed"), timeline: [] });
  await host.invoke(
    "agent.turn_ended",
    ended("native-completed", { kind: "completed" }, "other-native-agent"),
  );
  const toolContext = await post("agent-context", {
    project: null,
    provider: "omp",
    includeContext: false,
    includeTools: true,
  });
  expect(toolContext.status).toBe(200);
  const issued = AgentContextSchema.parse(toolContext.body);
  if (!issued.nonce) throw new Error("Expected actual memory-tool context for the review");
  const linked = await post("link-agent", {
    nonce: issued.nonce,
    agentId: "review-agent",
    workspaceId: null,
    title: "Review agent",
  });
  expect(linked.status).toBe(200);
  const started = await post("review-start", { agentId: "review-agent", trigger: "idle" });
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ ok: true });
  const review = ended("native-review", { kind: "completed" }, "review-agent");
  review.timeline = [
    { type: "user_message", text: reviewPrompt({ cap: 0, display: "collapsed" }) },
    {
      type: "assistant_message",
      text: "[paseo-memory:review-reply v1 collapsed]\nSummary: Verified release policy.\nNothing to save",
    },
  ];
  await host.invoke("agent.turn_ended", review);
  const totals = await usage();
  expect(totals.providerTurns).toMatchObject({
    attempts: 6,
    completed: 4,
    failed: 1,
    cancelled: 1,
    inputTokens: { providerObserved: null, localExact: null, estimated: null },
    outputTokens: { providerObserved: null, localExact: null, estimated: null },
    observedCosts: [],
    estimatedCosts: [],
    unavailableUsageAttempts: 6,
    unavailableBillingAttempts: 6,
  });
  expect(totals.stages.review).toMatchObject({ attempts: 1, completed: 1 });
  expect((await post("sessions", { query: "", paseoProjectId: null, limit: 50 })).body).toEqual({ items: [] });
});

it("keeps durable native accounting across plugin/service restart and failed capture", async () => {
  const host = await nativeHost({ autoCapture: true });
  host.transport.failures.add("record-turn");
  const event = ended("capture-failed-native-turn");
  await host.invoke("agent.turn_ended", event);
  expect(host.transport.faulted.has("record-turn")).toBe(true);
  expect((await usage()).providerTurns).toMatchObject({ attempts: 1, completed: 1 });
  await host.dispose();
  const running = live();
  service = undefined;
  await running.stop();
  service = await launch();
  const reopened = await nativeHost();
  await reopened.invoke("agent.turn_ended", event);
  expect((await usage()).providerTurns).toMatchObject({
    attempts: 1,
    completed: 1,
    unavailableUsageAttempts: 1,
    unavailableBillingAttempts: 1,
    observedCosts: [],
  });
});

it("omits unidentified native turns and conservatively coalesces repeated IDs after native reopen", async () => {
  const host = await nativeHost();
  await host.invoke("agent.turn_ended", ended(null));
  await host.invoke("agent.turn_ended", {
    ...ended(null),
    timeline: [
      { type: "user_message", text: "A different unidentified turn." },
      { type: "assistant_message", text: "A different completed reply." },
    ],
  });
  expect((await usage()).providerTurns.attempts).toBe(0);
  await host.invoke("agent.turn_ended", ended("reused-native-turn"));
  const request: PluginBeforeRequests["agent.session_open"] = {
    agentId: "host-agent",
    workspaceId: null,
    provider: "omp",
    cwd: dataDir,
    reason: "resume",
    purpose: "interactive",
    env: {},
  };
  await host.invoke("agent.session_open", { request });
  const repeated = ended("reused-native-turn");
  repeated.timeline = [
    { type: "user_message", text: "New resumed execution with no event-correlated session epoch." },
    { type: "assistant_message", text: "Completed after reopen." },
  ];
  await host.invoke("agent.turn_ended", repeated);
  expect((await usage()).providerTurns).toMatchObject({
    attempts: 1,
    completed: 1,
    unavailableBillingAttempts: 1,
  });
});

it("rejects forgotten context held before native output selection and never leaves a stale agent link", async () => {
  const memory = await seed();
  const host = await nativeHost({ injectMcp: true });
  host.transport.hold();
  manualDeadlines();
  const request: CreateRequest = {
    config: {
      provider: "omp",
      cwd: dataDir,
      systemPrompt: "Keep the original caller prompt.",
      mcpServers: { caller: { type: "http", url: "https://caller.invalid/mcp" } },
    },
    env: { CALLER_FLAG: "preserved" },
  };
  const output = host.invoke("agent.create", { request });
  const issued = await host.transport.ready;
  expect(issued.context?.contextText).toContain("independently observed rollout verification");
  const forgotten = await post("mutate", {
    requestId: "forget-held-native-context",
    operation: "forget",
    id: memory.id,
    expectedRevision: memory.revision,
  });
  expect(forgotten.status).toBe(200);
  expect((await post("lifecycle-detail", { id: memory.id })).body).toBeNull();
  host.transport.release();
  expect(await output).toBe(request);
  await host.transport.drain();
  expect((await usage()).memoryInput.attached).toBe(0);

  const fresh = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  expect(fresh.config.systemPrompt).toBe(request.config.systemPrompt);
  expect(fresh.env).toMatchObject(request.env);
  await host.invoke("agent.created", {
    agent: {
      id: "fresh-after-revocation",
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd: dataDir,
      title: "Fresh authorized agent",
    },
  });
  const started = await post("review-start", { agentId: "fresh-after-revocation", trigger: "idle" });
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ ok: true });
  await host.transport.drain();
  expect((await usage()).memoryInput.attached).toBe(0);
});

it("admits only the current issued injection identity without acknowledging consumption", async () => {
  await seed();
  const issued = await issuedContext();
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input, false)).status).toBe(401);
  for (const forged of [
    { ...input, policyRevision: issued.context.policyRevision },
    { ...input, memoryRefs: issued.context.memoryRefs },
  ]) expect((await post("context-admit", forged)).status).toBe(400);
  for (const unknown of [
    { ...input, retrievalId: "unissued-retrieval" },
    { ...input, nonce: "foreign-issuance" },
    { ...input, retrievalId: null },
  ]) {
    const denied = await post("context-admit", unknown);
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: { code: "context_invalidated" } });
  }
  const before = (await usage()).memoryInput;
  const admitted = await post("context-admit", input);
  expect(admitted.status).toBe(200);
  expect(admitted.body).toEqual({ admitted: true });
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  expect((await usage()).memoryInput).toEqual(before);
  expect(before).toMatchObject({ attempts: 1, prepared: 1, attached: 0, discarded: 0 });
});

it("admits genuine tools-only issuance without a fabricated fragment and rejects incomplete legacy issuance", async () => {
  const response = await post("agent-context", {
    project: null,
    provider: "omp",
    includeContext: false,
    includeTools: true,
  });
  expect(response.status).toBe(200);
  const issued = AgentContextSchema.parse(response.body);
  expect(issued.context).toBeNull();
  if (!issued.nonce) throw new Error("Expected a genuine tools-only nonce");
  const admitted = await post("context-admit", { nonce: issued.nonce, retrievalId: null });
  expect(admitted.status).toBe(200);
  expect(admitted.body).toEqual({ admitted: true });
  expect((await usage()).memoryInput.attempts).toBe(0);
  live().store.audit.open({ nonce: "legacy-without-snapshot", projectKey: null, provider: "omp", tools: true });
  live().store.audit.record("legacy-without-snapshot", {
    kind: "inject",
    memories: [],
    sessions: [],
    chars: 0,
    budget: 0,
  });
  const denied = await post("context-admit", { nonce: "legacy-without-snapshot", retrievalId: null });
  expect(denied.status).toBe(409);
  expect(denied.body).toMatchObject({ error: { code: "context_invalidated" } });
  expect((await usage()).memoryInput.attempts).toBe(0);
});

it("rejects old native issuance after source generation or owner disclosure policy changes", async () => {
  await seed();
  const first = await issuedContext();
  const added = await post("mutate", {
    requestId: "unrelated-source-generation",
    operation: "create",
    change: {
      title: "Independent operational convention",
      content: "A separate operational convention does not revise the pinned release policy.",
      state: "active",
      scope: "global",
    },
  });
  expect(added.status).toBe(200);
  const sourceDenied = await post("context-admit", {
    retrievalId: first.context.retrievalId,
    nonce: first.nonce,
  });
  expect(sourceDenied.status).toBe(409);
  const current = await issuedContext();
  expect((await post("context-admit", {
    retrievalId: current.context.retrievalId,
    nonce: current.nonce,
  })).body).toEqual({ admitted: true });
  const configured = await post("configure", {
    ...live().store.config,
    extraInstructions: "Use the owner's newly configured disclosure instructions.",
  });
  expect(configured.status).toBe(200);
  const policyDenied = await post("context-admit", {
    retrievalId: current.context.retrievalId,
    nonce: current.nonce,
  });
  expect(policyDenied.status).toBe(409);
  const fresh = await issuedContext();
  expect((await post("context-admit", {
    retrievalId: fresh.context.retrievalId,
    nonce: fresh.nonce,
  })).body).toEqual({ admitted: true });
});

it("rechecks selected session versions and scope instead of reusing an old session digest", async () => {
  expect((await post("configure", { ...live().store.config, recentSessions: 1 })).status).toBe(200);
  const turn = {
    agentId: "selected-source-session",
    project: dataRepo,
    provider: "omp",
    title: "Selected session",
    workspaceDir: dataRepo.rootPath,
    userText: "Document the initial session outcome.",
    assistantText: "Initial session outcome before the response was held.",
    files: [],
  };
  expect((await post("record-turn", turn)).status).toBe(200);
  const request = {
    project: dataRepo,
    provider: "omp",
    includeContext: true,
    includeTools: false,
    taskBudgetMs: 1000,
    retrieval: { recordKinds: ["episode"], detail: "full" },
  };
  const response = await post("agent-context", request);
  expect(response.status).toBe(200);
  const issued = AgentContextSchema.parse(response.body);
  if (!issued.context || !issued.nonce) throw new Error("Expected a selected session context");
  expect(issued.context.sessionIds).toEqual([turn.agentId]);
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  expect((await post("record-turn", {
    ...turn,
    userText: "Correct the session outcome.",
    assistantText: "Corrected session outcome from a newer actual turn.",
  })).status).toBe(200);
  const denied = await post("context-admit", input);
  expect(denied.status).toBe(409);
  expect(denied.body).toMatchObject({ error: { code: "context_invalidated" } });
  const fresh = AgentContextSchema.parse((await post("agent-context", request)).body);
  if (!fresh.context || !fresh.nonce) throw new Error("Expected current session context");
  expect(fresh.context.sessionIds).toEqual([turn.agentId]);
  expect((await post("context-admit", {
    retrievalId: fresh.context.retrievalId,
    nonce: fresh.nonce,
  })).body).toEqual({ admitted: true });
});

it("rejects a selected canonical record whose validity expires after preparation without a new write", async () => {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const memory = await seed();
  const updated = await post("mutate", {
    requestId: "bounded-native-validity",
    operation: "update",
    id: memory.id,
    expectedRevision: memory.revision,
    change: { validUntil: "2030-01-01T00:01:00.000Z" },
  });
  expect(updated.status).toBe(200);
  const issued = await issuedContext();
  expect(issued.context.memoryRefs.map((ref) => ref.id)).toEqual([memory.id]);
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  setSystemTime(new Date("2030-01-01T00:02:00.000Z"));
  const denied = await post("context-admit", input);
  expect(denied.status).toBe(409);
  expect(denied.body).toMatchObject({ error: { code: "context_invalidated" } });
});

it("preserves the exact caller request when final native admission is unavailable", async () => {
  await seed();
  const host = await nativeHost({ injectMcp: true });
  host.transport.failures.add("context-admit");
  const request: CreateRequest = {
    config: {
      provider: "omp",
      cwd: dataDir,
      systemPrompt: "Caller content must survive unavailable admission.",
      mcpServers: { caller: { type: "http", url: "https://caller.invalid/mcp" } },
    },
    env: { CALLER_FLAG: "unchanged" },
  };
  expect(await host.invoke("agent.create", { request })).toBe(request);
  await host.transport.drain();
  expect(host.transport.faulted.has("context-admit")).toBe(true);
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 0, discarded: 1, attached: 0 });
});

it("never selects or links output when final native admission arrives after the original deadline", async () => {
  await seed();
  const host = await nativeHost({ injectMcp: true });
  host.transport.holdAdmission();
  const deadlines = manualDeadlines();
  const request: CreateRequest = {
    config: { provider: "omp", cwd: dataDir, systemPrompt: "Return the original request on late admission." },
    env: { CALLER_FLAG: "preserved" },
  };
  const output = host.invoke("agent.create", { request });
  await host.transport.admissionReady;
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 1, attached: 0 });
  deadlines.expire();
  expect(await output).toBe(request);
  host.transport.release();
  await host.transport.drain();
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 0, discarded: 1, attached: 0 });
  const fresh = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  expect(fresh.config.systemPrompt).toContain("independently observed rollout verification");
  await host.invoke("agent.created", {
    agent: {
      id: "fresh-after-late-admission",
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd: dataDir,
      title: "Fresh selected output",
    },
  });
  expect(live().store.audit.nonceFor("fresh-after-late-admission")).toBe(fresh.env?.[NONCE_ENV]);
  await host.transport.drain();
});

it("keeps native tools-only creation prompt-free and supplies actually authorized MCP credentials", async () => {
  const memory = await seed();
  const host = await nativeHost({ injectContext: false, injectMcp: true });
  const request: CreateRequest = {
    config: {
      provider: "omp",
      cwd: dataDir,
      systemPrompt: "Do not attach automatic memory to this caller prompt.",
      mcpServers: { caller: { type: "http", url: "https://caller.invalid/mcp" } },
    },
    env: { CALLER_FLAG: "preserved" },
  };
  const output = HookOutputSchema.parse(await host.invoke("agent.create", { request }));
  expect(output.config.systemPrompt).toBe(request.config.systemPrompt);
  expect(output.env).toMatchObject(request.env);
  const servers = z.object({
    memory: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }),
    caller: z.object({ type: z.literal("http"), url: z.literal("https://caller.invalid/mcp") }),
  }).parse(output.config.mcpServers);
  await host.transport.drain();
  expect((await usage()).memoryInput.attempts).toBe(0);
  const response = await fetch(servers.memory.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...servers.memory.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "native-tools-only-read",
      method: "tools/call",
      params: { name: "memory_get", arguments: { ids: [memory.id] } },
    }),
  });
  expect(response.status).toBe(200);
  const result = McpResultSchema.parse(await response.json()).result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.retrieval.memoryRefs).toEqual([memory]);
  expect((await usage()).memoryInput).toMatchObject({ attempts: 1, prepared: 1, attached: 0 });
});
