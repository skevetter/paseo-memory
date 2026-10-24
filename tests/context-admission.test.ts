import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, setSystemTime, spyOn } from "bun:test";
import type { PluginBeforeRequests, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { PaseoApi } from "../server/host-types";
import { contributeServer } from "../server/plugin";
import { ServiceSupervisor } from "../server/supervisor";
import { type RunningService, serviceKey, startService } from "../service/app";
import { type MemorySettings, memorySettings } from "../shared/contracts";
import { MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { RetrievalResultSchema } from "../shared/retrieval";
import type { ServiceInput, ServiceOutputs, ServiceRoute } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, tempDir } from "./helpers";

type CreateRequest = PluginBeforeRequests["agent.create"];
type Hook = (input: unknown, context: PluginHookContext) => unknown;
const IssuedSchema = z.object({ context: RetrievalResultSchema.nullable(), nonce: z.string().nullable() });
let service: RunningService;
let directory: string;
let originalHome: string | undefined;
let originalDirectory: string | undefined;
const disposers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  originalHome = process.env.PASEO_HOME;
  originalDirectory = process.env.PASEO_MEMORY_DIR;
  directory = tempDir("pm-native-admission-");
  process.env.PASEO_HOME = directory;
  process.env.PASEO_MEMORY_DIR = directory;
  service = await startService({
    dataDir: directory,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
});
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  } finally {
    setSystemTime();
    await service?.stop();
    if (originalHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalHome;
    if (originalDirectory === undefined) delete process.env.PASEO_MEMORY_DIR;
    else process.env.PASEO_MEMORY_DIR = originalDirectory;
  }
});
async function post(route: string, body: unknown, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { "x-paseo-memory-key": serviceKey(service.secret) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
async function seed() {
  const result = await post("mutate", {
    requestId: "native-canary",
    operation: "create",
    change: {
      scope: "global",
      title: "Revoked handoff canary",
      content: "The synthetic canary must not enter a newly selected prompt after revocation.",
    },
  });
  expect(result.status).toBe(200);
  return MutationResultSchema.parse(result.body).memoryRef;
}
function originalRequest() {
  return {
    config: {
      provider: "omp",
      cwd: directory,
      systemPrompt: "Keep the original caller prompt.",
      mcpServers: { caller: { type: "http", url: "https://caller.invalid/mcp" } },
    },
    env: { CALLER_SETTING: "preserved" },
  } satisfies CreateRequest;
}
function nativeTransport() {
  const configured = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<ServiceOutputs["agent-context"]>();
  const admitted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const failures = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const held = new Map<ServiceRoute, Promise<void>>();
  async function forward<R extends ServiceRoute>(
    route: R,
    input: ServiceInput<R>,
  ): Promise<ServiceOutputs[R]> {
    if (failures.has(route)) throw new Error(`Controlled ${route} transport failure`);
    const response = await post(route, input);
    if (response.status !== 200) throw new Error(`${route}: ${JSON.stringify(response.body)}`);
    if (route === "agent-context") prepared.resolve(response.body as ServiceOutputs["agent-context"]);
    if (route === "context-admit") admitted.resolve();
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
    prepared: prepared.promise,
    admitted: admitted.promise,
    holdAdmission: () => {
      held.set("context-admit", released.promise);
    },
    failures,
    hold: () => {
      held.set("agent-context", released.promise);
    },
    release: () => released.resolve(),
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
  const hooks = new Map<string, Hook>();
  const register = (name: string, hook: Hook) => {
    hooks.set(name, hook);
    return () => {
      hooks.delete(name);
    };
  };
  const settings = memorySettings.schema.parse({
    autoCapture: false,
    reviewTrigger: "off",
    injectContext: true,
    injectMcp: true,
    ...overrides,
  });
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: settings }),
      subscribe: () => () => undefined,
    }),
    before: register,
    on: register,
    handle: () => undefined,
  } as unknown as PluginServerContext;
  const transport = nativeTransport();
  const cleanup = contributeServer(server);
  await transport.configured;
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }),
    },
    projects: { list: async () => ({ projects: [] }) },
  } as unknown as PaseoApi;
  const context: PluginHookContext = { paseo, signal: new AbortController().signal };
  disposers.push(async () => {
    transport.release();
    try {
      await transport.drain();
      await cleanup();
    } finally {
      transport.restore();
    }
  });
  return {
    transport,
    async invoke(name: string, input: unknown): Promise<unknown> {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`Missing native hook ${name}`);
      return hook(input, context);
    },
  };
}

async function readInjected(server: unknown, id: number) {
  const config = z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }).parse(server);
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...config.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "admitted-native-read",
      method: "tools/call",
      params: { name: "memory_get", arguments: { ids: [id] } },
    }),
  });
  expect(response.status).toBe(200);
  const result = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.object({ retrieval: RetrievalResultSchema.omit({ contextText: true }) }),
      }),
    })
    .parse(await response.json()).result;
  expect(result.isError).not.toBe(true);
  return result.structuredContent.retrieval.memoryRefs;
}

it("admits current context and preserves the caller prompt, MCP servers and environment", async () => {
  const memory = await seed();
  const host = await nativeHost();
  const request = originalRequest();
  const output = z
    .object({
      config: z.object({ systemPrompt: z.string(), mcpServers: z.record(z.string(), z.unknown()) }),
      env: z.record(z.string(), z.string()),
    })
    .parse(await host.invoke("agent.create", { request }));
  expect(output.config.systemPrompt).toContain(request.config.systemPrompt);
  expect(output.config.systemPrompt).toContain("Revoked handoff canary");
  expect(output.config.mcpServers.caller).toEqual(request.config.mcpServers?.caller);
  expect(await readInjected(output.config.mcpServers.memory, memory.id)).toEqual([memory]);
  expect(output.env.CALLER_SETTING).toBe("preserved");
  const issued = IssuedSchema.parse(await host.transport.prepared);
  if (!issued.nonce) throw new Error("Expected an admitted managed capability");
  expect(output.env.PASEO_MEMORY_NONCE).toBe(issued.nonce);
});

it("rejects forgotten context held before output and leaves fresh agent binding usable", async () => {
  const memory = await seed();
  const host = await nativeHost();
  host.transport.hold();
  const request = originalRequest();
  const pending = host.invoke("agent.create", { request });
  const issued = IssuedSchema.parse(await host.transport.prepared);
  expect(issued.context?.memoryRefs).toContainEqual(memory);
  expect(
    (
      await post("mutate", {
        requestId: "forget-held",
        operation: "forget",
        id: memory.id,
        expectedRevision: memory.revision,
      })
    ).status,
  ).toBe(200);
  expect((await post("lifecycle-detail", { id: memory.id })).body).toBeNull();
  host.transport.release();
  expect(await pending).toEqual(request);
  const freshOutput = z
    .object({ env: z.object({ PASEO_MEMORY_NONCE: z.string().min(1) }).passthrough() })
    .parse(await host.invoke("agent.create", { request }));
  await host.invoke("agent.created", {
    agent: {
      id: "fresh-native-agent",
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd: directory,
      title: "Fresh synthetic agent",
    },
  });
  await host.transport.drain();
  expect(service.store.audit.agentFor(freshOutput.env.PASEO_MEMORY_NONCE)).toBe("fresh-native-agent");
});

it.each(["policy", "correction", "scope", "expiry"] as const)(
  "rejects held context after %s changes without altering caller input",
  async (change) => {
    const memory = await seed();
    const host = await nativeHost();
    host.transport.hold();
    const request = originalRequest();
    const pending = host.invoke("agent.create", { request });
    await host.transport.prepared;
    if (change === "policy") {
      const policy = structuredClone(service.store.config.retrievalPolicy);
      policy.profiles.standard.maxChars = 0;
      service.store.configure({ ...service.store.config, retrievalPolicy: policy });
    } else {
      if (change === "scope") service.store.upsertProject(otherRepo);
      const patch =
        change === "scope"
          ? { scope: "project", project: otherRepo }
          : change === "expiry"
            ? { validUntil: "2020-01-01T00:00:00Z" }
            : { content: "The corrected source must replace the prior claim" };
      expect(
        (
          await post("mutate", {
            requestId: `change-${change}`,
            operation: "update",
            id: memory.id,
            expectedRevision: memory.revision,
            change: patch,
          })
        ).status,
      ).toBe(200);
    }
    host.transport.release();
    expect(await pending).toEqual(request);
  },
);

it("keeps genuine tools-only issuance working and fails closed when admission is unavailable", async () => {
  const memory = await seed();
  const host = await nativeHost({ injectContext: false });
  const request = originalRequest();
  const output = z
    .object({
      config: z.object({ systemPrompt: z.string(), mcpServers: z.record(z.string(), z.unknown()) }),
      env: z.record(z.string(), z.string()),
    })
    .parse(await host.invoke("agent.create", { request }));
  expect(output.config.systemPrompt).toBe(request.config.systemPrompt);
  expect(await readInjected(output.config.mcpServers.memory, memory.id)).toEqual([memory]);
  expect(output.env.CALLER_SETTING).toBe("preserved");
  host.transport.failures.add("context-admit");
  expect(await host.invoke("agent.create", { request })).toEqual(request);
});

it("requires actual issued identity and rejects forged selection or unauthenticated admission", async () => {
  await seed();
  const issued = IssuedSchema.parse(
    (
      await post("agent-context", {
        project: null,
        provider: "omp",
        includeContext: true,
        includeTools: true,
      })
    ).body,
  );
  if (!issued.context || !issued.nonce) throw new Error("Expected full native issuance");
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  for (const body of [
    { ...input, nonce: "unknown" },
    { ...input, retrievalId: null },
    { ...input, memoryRefs: [] },
  ]) {
    const result = await post("context-admit", body);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  }
  expect((await post("context-admit", input, false)).status).toBe(401);
});

it("rejects a session proof changed by an external writer after selected-row read", async () => {
  expect((await post("configure", { ...service.store.config, recentSessions: 1 })).status).toBe(200);
  const turn = {
    agentId: "external-session-source",
    project: dataRepo,
    provider: "omp",
    title: "Original snapshot title",
    workspaceDir: dataRepo.rootPath,
    userText: "Describe the source session.",
    assistantText: "A synthetic session outcome.",
    files: [],
  };
  expect((await post("record-turn", turn)).status).toBe(200);
  const writer = new Database(service.status().dbPath);
  const read = service.store.visibleSessions.bind(service.store);
  let replaced = false;
  const selected = spyOn(service.store, "visibleSessions").mockImplementation((...input) => {
    const rows = read(...input);
    if (!replaced && rows.some((row) => row.id === turn.agentId)) {
      writer.query("UPDATE sessions SET title=? WHERE id=?").run("Replacement snapshot title", turn.agentId);
      replaced = true;
    }
    return rows;
  });
  const request = {
    project: dataRepo,
    provider: "omp",
    includeContext: true,
    includeTools: false,
    retrieval: { recordKinds: ["episode"], detail: "full" },
  };
  try {
    const issued = IssuedSchema.parse((await post("agent-context", request)).body);
    if (!issued.context || !issued.nonce) throw new Error("Expected a selected session context");
    expect(replaced).toBe(true);
    expect(issued.context.contextText).toContain(turn.title);
    expect(issued.context.sessionIds).toEqual([turn.agentId]);
    const denied = await post("context-admit", {
      retrievalId: issued.context.retrievalId,
      nonce: issued.nonce,
    });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: { code: "context_invalidated" } });
    const fresh = IssuedSchema.parse((await post("agent-context", request)).body);
    if (!fresh.context || !fresh.nonce) throw new Error("Expected a current session context");
    expect(fresh.context.contextText).toContain("Replacement snapshot title");
    expect(fresh.context.contextText).not.toContain(turn.title);
    expect(
      (await post("context-admit", { retrievalId: fresh.context.retrievalId, nonce: fresh.nonce })).body,
    ).toEqual({ admitted: true });
  } finally {
    selected.mockRestore();
    writer.close();
  }
});

it("retains context-only injection without adding a Memory MCP server", async () => {
  await seed();
  const host = await nativeHost({ injectMcp: false });
  const request = originalRequest();
  const output = z
    .object({ config: z.object({ systemPrompt: z.string(), mcpServers: z.record(z.string(), z.unknown()) }) })
    .parse(await host.invoke("agent.create", { request }));
  expect(output.config.systemPrompt).toContain("Revoked handoff canary");
  expect(output.config.systemPrompt).toContain(request.config.systemPrompt);
  expect(output.config.mcpServers).toEqual(request.config.mcpServers);
});

it("rejects clock-only canonical expiry without relying on a source-generation change", async () => {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const memory = await seed();
  expect(
    (
      await post("mutate", {
        requestId: "native-valid-until",
        operation: "update",
        id: memory.id,
        expectedRevision: memory.revision,
        change: { validUntil: "2030-01-01T00:01:00.000Z" },
      })
    ).status,
  ).toBe(200);
  const issued = IssuedSchema.parse(
    (
      await post("agent-context", {
        project: null,
        provider: "omp",
        includeContext: true,
        includeTools: false,
      })
    ).body,
  );
  if (!issued.context || !issued.nonce) throw new Error("Expected bounded canonical context");
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  const generation = service.store.retrievalGeneration;
  setSystemTime(new Date("2030-01-01T00:02:00.000Z"));
  expect(service.store.retrievalGeneration).toBe(generation);
  expect((await post("context-admit", input)).body).toMatchObject({ error: { code: "context_invalidated" } });
});

it("rejects a selected session replaced after preparation and admits its fresh digest", async () => {
  await post("configure", { ...service.store.config, recentSessions: 1 });
  const turn = {
    agentId: "replaced-session-source",
    project: dataRepo,
    provider: "omp",
    title: "Session replacement",
    workspaceDir: dataRepo.rootPath,
    userText: "Describe the initial result.",
    assistantText: "Old session result.",
    files: [],
  };
  expect((await post("record-turn", turn)).status).toBe(200);
  const request = {
    project: dataRepo,
    provider: "omp",
    includeContext: true,
    includeTools: false,
    retrieval: { recordKinds: ["episode"], detail: "full" },
  };
  const issued = IssuedSchema.parse((await post("agent-context", request)).body);
  if (!issued.context || !issued.nonce) throw new Error("Expected selected session");
  expect(issued.context.sessionIds).toEqual([turn.agentId]);
  const input = { retrievalId: issued.context.retrievalId, nonce: issued.nonce };
  expect((await post("context-admit", input)).body).toEqual({ admitted: true });
  expect((await post("record-turn", { ...turn, assistantText: "Corrected session result." })).status).toBe(
    200,
  );
  expect((await post("context-admit", input)).body).toMatchObject({ error: { code: "context_invalidated" } });
  const fresh = IssuedSchema.parse((await post("agent-context", request)).body);
  if (!fresh.context || !fresh.nonce) throw new Error("Expected current session");
  expect(
    (await post("context-admit", { retrievalId: fresh.context.retrievalId, nonce: fresh.nonce })).body,
  ).toEqual({ admitted: true });
});

it("never selects or links output when admission arrives after the original create deadline", async () => {
  await seed();
  const host = await nativeHost();
  host.transport.holdAdmission();
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const request = originalRequest();
  try {
    const pending = host.invoke("agent.create", { request });
    await host.transport.admitted;
    now = 10_000;
    host.transport.release();
    expect(await pending).toEqual(request);
    await host.transport.drain();
  } finally {
    clock.mockRestore();
    host.transport.release();
  }
  const fresh = z
    .object({ env: z.object({ PASEO_MEMORY_NONCE: z.string().min(1) }) })
    .parse(await host.invoke("agent.create", { request }));
  await host.invoke("agent.created", {
    agent: {
      id: "after-deadline-agent",
      workspaceId: null,
      parentAgentId: null,
      provider: "omp",
      cwd: directory,
      title: "Fresh deadline control",
    },
  });
  await host.transport.drain();
  expect(service.store.audit.agentFor(fresh.env.PASEO_MEMORY_NONCE)).toBe("after-deadline-agent");
});
