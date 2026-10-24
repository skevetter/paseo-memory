import { afterAll, afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeDiscovery, BridgeDiscoverySchema } from "../server/bridge-discovery";
import { type RunningService, serviceKey, startService } from "../service/app";
import {
  BridgeNativeCreateResultSchema,
  BridgeRotationResultSchema,
  BridgeSessionResultSchema,
} from "../shared/bridge";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder, removeTempDirs, tempDir } from "./helpers";

let service: RunningService | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
});
afterAll(removeTempDirs);
const policy = { id: "owner-qa", readNamespaces: [{ kind: "bot", botId: "owner-qa" }], writeNamespaces: [] };
const credentialSchema = z.object({ credential: z.string() });

function credential(dataDir: string): string {
  const descriptor = BridgeDiscoverySchema.parse(
    JSON.parse(readFileSync(join(dataDir, "bridge-v1.json"), "utf8")),
  );
  const controller = descriptor.controllers.find((entry) => entry.consumerId === policy.id);
  if (!controller) throw new Error("Configured controller missing from discovery.");
  return credentialSchema.parse(JSON.parse(readFileSync(join(dataDir, controller.credentialRef), "utf8")))
    .credential;
}
async function boot(dataDir = tempDir("pm-bridge-owner-")) {
  service = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
  const base = `http://127.0.0.1:${service.port}`;
  const owner = { [SERVICE_KEY_HEADER]: serviceKey(service.secret) };
  async function post(path: string, input: unknown, headers: Record<string, string> = owner) {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  async function configure(enabled: boolean) {
    const response = await post("/v1/configure", {
      ...DEFAULT_RUNTIME,
      bridge: { enabled, consumers: [policy] },
    });
    expect(response.status).toBe(200);
  }
  return {
    dataDir,
    base,
    post,
    configure,
    capability: (token: string) =>
      fetch(`${base}/bridge/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } }),
  };
}
function registration() {
  return {
    protocolVersion: 1,
    requestId: "register",
    action: "register",
    botId: "owner-qa",
    runId: "run-qa",
    cycleId: "cycle-qa",
    attemptId: "attempt-qa",
    executionId: "execution-qa",
    sessionEpoch: 1,
    agentId: "agent-qa",
    providerTurnId: null,
    purpose: "task",
    expectedIdentity: { workspaceId: null, provider: "omp", cwd: "/tmp/owner-qa" },
    requestedNamespaces: [{ kind: "bot", botId: "owner-qa" }],
    ownership: { contextOwner: "paseo-bots", captureOwner: "paseo-bots", reviewOwner: "paseo-bots" },
  };
}

it("rotates controller authority, revokes outstanding sessions, and replays rotation without rotating twice", async () => {
  const h = await boot();
  await h.configure(true);
  const old = credential(h.dataDir);
  const pending = await h.post("/bridge/v1/sessions", registration(), { Authorization: `Bearer ${old}` });
  expect(pending.status).toBe(200);
  const session = BridgeSessionResultSchema.parse(await pending.json());
  const input = { consumerId: policy.id, expectedVersion: 1, requestId: "rotate-qa" };
  const rotated = await h.post("/v1/bridge-rotate", input);
  expect(rotated.status).toBe(200);
  const result = BridgeRotationResultSchema.parse(await rotated.json());
  expect(result.credentialVersion).toBe(2);
  const fresh = credential(h.dataDir);
  expect(fresh).not.toBe(old);
  expect((await h.capability(old)).status).toBe(401);
  expect((await h.capability(fresh)).status).toBe(200);
  const context = await h.post(
    "/bridge/v1/context",
    {
      protocolVersion: 1,
      requestId: "context",
      sessionId: session.sessionId,
      leaseVersion: 1,
      query: "",
      namespaceFilter: [{ kind: "bot", botId: "owner-qa" }],
      recordKinds: ["fact"],
      budget: { maxTokens: 4096, maxChars: 6000, maxLatencyMs: 1000 },
    },
    { Authorization: `Bearer ${session.sessionToken}` },
  );
  expect(context.status).toBe(409);
  expect(
    z.object({ error: z.object({ code: z.literal("lease_expired") }) }).parse(await context.json()).error
      .code,
  ).toBe("lease_expired");
  expect(BridgeRotationResultSchema.parse(await (await h.post("/v1/bridge-rotate", input)).json())).toEqual(
    result,
  );
  expect(credential(h.dataDir)).toBe(fresh);
  expect((await h.post("/v1/bridge-rotate", { ...input, expectedVersion: 2 })).status).toBe(409);
  expect((await h.post("/v1/bridge-rotate", { ...input, requestId: "stale-rotation" })).status).toBe(409);
  expect(
    (
      await h.post(
        "/v1/bridge-rotate",
        { ...input, requestId: "forged" },
        { Authorization: `Bearer ${fresh}` },
      )
    ).status,
  ).toBe(401);
  await service?.stop();
  service = undefined;
  const reopened = await boot(h.dataDir);
  expect(credential(h.dataDir)).toBe(fresh);
  expect((await reopened.capability(old)).status).toBe(401);
  expect((await reopened.capability(fresh)).status).toBe(200);
});

it("never resurrects a disabled controller credential and reports native qualification without secrets", async () => {
  const h = await boot();
  await h.configure(true);
  const old = credential(h.dataDir);
  await h.configure(false);
  expect((await h.capability(old)).status).toBe(503);
  await h.configure(true);
  const fresh = credential(h.dataDir);
  expect(fresh).not.toBe(old);
  expect((await h.capability(old)).status).toBe(401);
  const status = await h.post("/v1/bridge-status", {});
  expect(status.status).toBe(200);
  const snapshot = z
    .object({
      enabled: z.boolean(),
      consumers: z.array(z.object({ credentialVersion: z.number() })),
      native: z.object({
        createObservation: z.literal("provider_cwd_only"),
        credentialRollover: z.literal("unsupported_new_execution_required"),
        pairedValidation: z.literal("not_qualified"),
        trustedEvidenceResolver: z.literal("unavailable"),
      }),
    })
    .parse(await status.json());
  expect(snapshot.enabled).toBe(true);
  expect(snapshot.consumers).toEqual([{ credentialVersion: 2 }]);
  expect(JSON.stringify(snapshot)).not.toContain(fresh);
});

it("rejects malformed UTF-8 before any Bridge request can be committed", async () => {
  const h = await boot();
  await h.configure(true);
  const response = await fetch(`${h.base}/bridge/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${credential(h.dataDir)}` },
    body: new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]),
  });
  expect(response.status).toBe(422);
  expect(
    z.object({ error: z.object({ code: z.literal("unsupported_version") }) }).parse(await response.json())
      .error.code,
  ).toBe("unsupported_version");
});

it("does not let an old service shutdown disable the replacement discovery endpoint", () => {
  const dir = tempDir("pm-bridge-replacement-");
  const old = new BridgeDiscovery(dir, "old-instance");
  old.publish(
    "http://127.0.0.1:10001/bridge/v1",
    [{ consumerId: policy.id, token: "old-private-token" }],
    true,
  );
  const fresh = new BridgeDiscovery(dir, "fresh-instance");
  fresh.publish(
    "http://127.0.0.1:10002/bridge/v1",
    [{ consumerId: policy.id, token: "new-private-token" }],
    true,
  );
  old.stopped();
  const snapshot = BridgeDiscoverySchema.parse(JSON.parse(readFileSync(join(dir, "bridge-v1.json"), "utf8")));
  expect(snapshot.enabled).toBe(true);
  expect(snapshot.endpoint).toBe("http://127.0.0.1:10002/bridge/v1");
  expect(credential(dir)).toBe("new-private-token");
  fresh.stopped();
  expect(
    BridgeDiscoverySchema.parse(JSON.parse(readFileSync(join(dir, "bridge-v1.json"), "utf8"))).enabled,
  ).toBe(false);
});

it("advertises current consumer-granted owner context caps rather than absolute budgets", async () => {
  const h = await boot();
  await h.configure(true);
  const token = credential(h.dataDir);
  const limits = z.object({
    limits: z.object({ maxContextTokens: z.number(), maxContextChars: z.number() }),
  });
  expect(limits.parse(await (await h.capability(token)).json()).limits).toEqual({
    maxContextTokens: 8192,
    maxContextChars: 6000,
  });
  const name = DEFAULT_RUNTIME.retrievalPolicy.defaultProfile;
  const narrowed = {
    ...DEFAULT_RUNTIME,
    contextBudgetChars: 1500,
    retrievalPolicy: {
      ...DEFAULT_RUNTIME.retrievalPolicy,
      profiles: {
        ...DEFAULT_RUNTIME.retrievalPolicy.profiles,
        [name]: { ...DEFAULT_RUNTIME.retrievalPolicy.profiles[name], maxTokens: 2048, maxChars: 1800 },
      },
    },
    bridge: { enabled: true, consumers: [policy] },
  };
  expect((await h.post("/v1/configure", narrowed)).status).toBe(200);
  expect(limits.parse(await (await h.capability(token)).json()).limits).toEqual({
    maxContextTokens: 2048,
    maxContextChars: 1500,
  });
  expect(
    (
      await h.post("/v1/configure", {
        ...narrowed,
        bridge: { enabled: true, consumers: [{ ...policy, functions: ["sessions"] }] },
      })
    ).status,
  ).toBe(200);
  expect(limits.parse(await (await h.capability(token)).json()).limits).toEqual({
    maxContextTokens: 0,
    maxContextChars: 0,
  });
});

it("never discloses a blind-write namespace through stale MCP compare-and-swap diagnostics", async () => {
  const h = await boot();
  const botId = "private-write-only";
  const ref = await blindWriteTarget(h, botId);
  const controller = { Authorization: `Bearer ${credential(h.dataDir)}` };
  const input = {
    ...registration(),
    botId,
    purpose: "memory_review",
    requestedNamespaces: [{ kind: "bot", botId }],
  };
  const registeredResponse = await h.post("/bridge/v1/sessions", input, controller);
  expect(registeredResponse.status).toBe(200);
  const registered = BridgeSessionResultSchema.parse(await registeredResponse.json());
  const stagedResponse = await h.post("/v1/bridge-create", {
    bootstrapRef: registered.bootstrapRef,
    identity: input.expectedIdentity,
    configHash: "a".repeat(64),
  });
  expect(stagedResponse.status).toBe(200);
  const staged = BridgeNativeCreateResultSchema.parse(await stagedResponse.json());
  expect(
    (
      await h.post(
        "/bridge/v1/sessions",
        {
          protocolVersion: 1,
          requestId: "bind",
          action: "bind",
          sessionId: registered.sessionId,
          leaseVersion: 1,
          actualAgentId: input.agentId,
          observedIdentity: input.expectedIdentity,
          sessionEpoch: 1,
          bootstrapRef: registered.bootstrapRef,
        },
        controller,
      )
    ).status,
  ).toBe(200);
  const response = await h.post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_mutate",
        arguments: {
          requestId: "blind-cas",
          operation: "update",
          id: ref.id,
          expectedRevision: ref.revision,
          change: { content: "Unapproved blind replacement" },
        },
      },
    },
    staged.mcpServer.headers,
  );
  expect(response.status).toBe(200);
  const packet = await response.json();
  expect(z.object({ result: z.object({ isError: z.literal(true) }) }).parse(packet).result.isError).toBe(
    true,
  );
  const rendered = JSON.stringify(packet);
  expect(rendered).toContain("revision_conflict");
  expect(rendered).not.toContain("PRIVATE_QA_TITLE");
  expect(rendered).not.toContain("PRIVATE_QA_CONTENT");
});

async function blindWriteTarget(h: { post(path: string, input: unknown): Promise<Response> }, botId: string) {
  expect(
    (
      await h.post("/v1/configure", {
        ...DEFAULT_RUNTIME,
        bridge: {
          enabled: true,
          consumers: [
            {
              ...policy,
              readNamespaces: [],
              writeNamespaces: [{ kind: "bot", botId }],
              mutations: ["update"],
              mutationPurposes: ["memory_review"],
            },
          ],
        },
      })
    ).status,
  ).toBe(200);
  const saved = await h.post("/v1/save", {
    title: "PRIVATE_QA_TITLE",
    content: "PRIVATE_QA_CONTENT_OLD",
    type: "note",
    scope: "bot",
    botId,
    paseoProjectId: null,
    project: null,
    pinned: false,
  });
  expect(saved.status).toBe(200);
  const ref = z
    .object({ memoryRef: z.object({ id: z.number(), revision: z.number() }) })
    .parse(await saved.json()).memoryRef;
  expect(
    (
      await h.post("/v1/mutate", {
        requestId: "private-correction",
        operation: "update",
        id: ref.id,
        expectedRevision: ref.revision,
        change: { content: "PRIVATE_QA_CONTENT_CURRENT" },
      })
    ).status,
  ).toBe(200);
  return ref;
}
