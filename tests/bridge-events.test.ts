import { afterAll, afterEach, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeDiscoverySchema } from "../server/bridge-discovery";
import { type RunningService, serviceKey, startService } from "../service/app";
import { openDatabase } from "../service/sqlite";
import { sha256 } from "../service/text";
import {
  BRIDGE_FIXTURE_SHA256,
  BridgeContextResultSchema,
  BridgeEventAckSchema,
  type BridgeOrigin,
  BridgeSessionResultSchema,
} from "../shared/bridge";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder, removeTempDirs, tempDir } from "./helpers";

// Controlled HTTP state machine over the real service. Not native SDK proof.

interface MemoryRef {
  id: number;
  revision: number;
}

interface Reply {
  status: number;
  body: unknown;
}

interface Harness {
  dataDir: string;
  base: string;
  owner: Record<string, string>;
  controller: Record<string, string>;
  alpha: MemoryRef;
  beta: MemoryRef;
}

interface Session {
  h: Harness;
  origin: BridgeOrigin;
  identity: { workspaceId: null; provider: "omp"; cwd: string };
  sessionId: string;
  token: string;
  alpha: MemoryRef;
  beta: MemoryRef;
}

let running: RunningService | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

afterAll(() => removeTempDirs());

const object = z.record(z.string(), z.unknown());

async function post(
  base: string,
  path: string,
  headers: Record<string, string>,
  input: unknown,
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: object.parse(await response.json()) };
}

function expectStatus(reply: Reply, status = 200): unknown {
  if (reply.status !== status) {
    throw new Error(`HTTP ${reply.status}, expected ${status}: ${JSON.stringify(reply.body)}`);
  }
  return reply.body;
}

function codeOf(body: unknown): string {
  return z.object({ error: z.object({ code: z.string() }) }).parse(body).error.code;
}

// Starts a real service with a deterministic embedder, one bot-scoped controller,
// and two saved bot memories (alpha granted, beta foreign).
async function launch(
  writeNamespaces: object[] = [{ kind: "bot", botId: "synthetic-alpha" }],
): Promise<Harness> {
  const dataDir = tempDir("pm-bridge-events-");
  const service = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  running = service;
  await service.modelsReady();
  const base = `http://127.0.0.1:${service.port}`;
  const owner = { [SERVICE_KEY_HEADER]: serviceKey(service.secret) };
  expectStatus(
    await post(base, "/v1/configure", owner, {
      ...DEFAULT_RUNTIME,
      detailLevel: "summaries",
      bridge: {
        enabled: true,
        consumers: [
          {
            id: "synthetic-controller",
            readNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }],
            writeNamespaces,
          },
        ],
      },
    }),
  );
  const save = async (botId: string, title: string): Promise<MemoryRef> => {
    const body = await post(base, "/v1/save", owner, {
      title,
      content: `${title} is an isolated QA statement, never real user data.`,
      type: "note",
      scope: "bot",
      botId,
      paseoProjectId: null,
      project: null,
      pinned: false,
    });
    return z
      .object({ memoryRef: z.object({ id: z.number(), revision: z.number() }) })
      .parse(expectStatus(body)).memoryRef;
  };
  const alpha = await save("synthetic-alpha", "SYNTHETIC_ALPHA_RECORD");
  const beta = await save("synthetic-beta", "SYNTHETIC_BETA_CANARY");
  await service.store.indexPending();
  const descriptor = BridgeDiscoverySchema.parse(
    JSON.parse(readFileSync(join(dataDir, "bridge-v1.json"), "utf8")),
  );
  const controller = descriptor.controllers.find((entry) => entry.consumerId === "synthetic-controller");
  if (!controller) throw new Error("The configured controller was not published.");
  const credential = z
    .object({ credential: z.string() })
    .parse(JSON.parse(readFileSync(join(dataDir, controller.credentialRef), "utf8")));
  return {
    dataDir,
    base,
    owner,
    controller: { Authorization: `Bearer ${credential.credential}` },
    alpha,
    beta,
  };
}

// Registers, binds, and opens a session the same way the smoke does.
async function bindSession(h: Harness): Promise<Session> {
  const agentId = randomUUID();
  const identity = { workspaceId: null, provider: "omp" as const, cwd: h.dataDir };
  const origin = sessionOrigin(agentId);
  const registered = BridgeSessionResultSchema.parse(
    expectStatus(
      await post(h.base, "/bridge/v1/sessions", h.controller, {
        protocolVersion: 1,
        requestId: "register-1",
        action: "register",
        ...origin,
        expectedIdentity: identity,
        requestedNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }],
        ownership: { contextOwner: "paseo-bots", captureOwner: "paseo-bots", reviewOwner: "paseo-bots" },
      }),
    ),
  );
  const registeredHeader = { Authorization: `Bearer ${registered.sessionToken}` };
  const context = BridgeContextResultSchema.parse(
    expectStatus(
      await post(h.base, "/bridge/v1/context", registeredHeader, {
        protocolVersion: 1,
        requestId: "context-1",
        sessionId: registered.sessionId,
        leaseVersion: 1,
        query: "",
        namespaceFilter: [{ kind: "bot", botId: "synthetic-alpha" }],
        recordKinds: ["fact"],
        budget: { maxTokens: 4096, maxChars: 6000, maxLatencyMs: 2000 },
      }),
    ),
  );
  const staged = z
    .object({
      mcpServer: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }),
    })
    .parse(
      expectStatus(
        await post(h.base, "/v1/bridge-create", h.owner, {
          bootstrapRef: registered.bootstrapRef,
          identity,
          configHash: sha256(
            JSON.stringify({ provider: "omp", cwd: h.dataDir, systemPrompt: context.contextText }),
          ),
        }),
      ),
    );
  await assertMcpCredential(h, staged.mcpServer.headers, 403);
  const bound = BridgeSessionResultSchema.parse(
    expectStatus(
      await post(h.base, "/bridge/v1/sessions", h.controller, {
        protocolVersion: 1,
        requestId: "bind-1",
        action: "bind",
        sessionId: registered.sessionId,
        leaseVersion: 1,
        actualAgentId: agentId,
        observedIdentity: identity,
        sessionEpoch: 1,
        bootstrapRef: registered.bootstrapRef,
      }),
    ),
  );
  await assertMcpCredential(h, staged.mcpServer.headers);
  expectStatus(
    await post(h.base, "/v1/bridge-open", h.owner, {
      agentId,
      identity,
      purpose: "interactive",
      reason: "create",
    }),
  );
  return {
    h,
    origin,
    identity,
    sessionId: bound.sessionId,
    token: bound.sessionToken,
    alpha: h.alpha,
    beta: h.beta,
  };
}

async function assertMcpCredential(h: Harness, headers: Record<string, string>, status = 200): Promise<void> {
  expectStatus(
    await post(h.base, "/mcp", headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "isolated-m07-test", version: "1" },
      },
    }),
    status,
  );
}

function sessionAuth(s: Session): Record<string, string> {
  return { Authorization: `Bearer ${s.token}` };
}

function eventFor(s: Session, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...s.origin,
    type: "cycle.completed",
    eventId: "event-1",
    startedAt: "2026-10-24T00:00:00.000Z",
    completedAt: "2026-10-24T00:01:00.000Z",
    summary: "Isolated synthetic cycle observation.",
    sourceRefs: [],
    memoryRefs: [s.alpha],
    outcome: { status: "unknown", evidenceRefs: [] },
    modelUsageRefs: [],
    ...overrides,
  };
}

function envelope(
  s: Session,
  requestId: string,
  event: Record<string, unknown>,
  leaseVersion = 2,
): Record<string, unknown> {
  return { protocolVersion: 1, requestId, sessionId: s.sessionId, leaseVersion, event };
}

function sendEvent(s: Session, input: unknown): Promise<Reply> {
  return post(s.h.base, "/bridge/v1/events", sessionAuth(s), input);
}

it("bridge events: accepted receipt replays exact ack and new transport duplicates the eventRef", async () => {
  const s = await bindSession(await launch());
  const input = envelope(s, "event-request-1", eventFor(s));
  const ack = BridgeEventAckSchema.parse(expectStatus(await sendEvent(s, input)));
  expect(ack.status).toBe("accepted");
  expect(BridgeEventAckSchema.parse(expectStatus(await sendEvent(s, input)))).toEqual(ack);
  const duplicate = BridgeEventAckSchema.parse(
    expectStatus(await sendEvent(s, envelope(s, "event-request-2", eventFor(s)))),
  );
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.eventRef).toBe(ack.eventRef);
});

it("bridge events: changed summary under same eventId is request_conflict", async () => {
  const s = await bindSession(await launch());
  expectStatus(await sendEvent(s, envelope(s, "event-request-1", eventFor(s))));
  const changed = await sendEvent(
    s,
    envelope(s, "event-request-2", eventFor(s, { summary: "Different synthetic summary." })),
  );
  expectStatus(changed, 409);
  expect(codeOf(changed.body)).toBe("request_conflict");
});

it("bridge events: reused transport requestId with changed content is request_conflict", async () => {
  const s = await bindSession(await launch());
  expectStatus(await sendEvent(s, envelope(s, "event-request-1", eventFor(s))));
  const reused = await sendEvent(
    s,
    envelope(s, "event-request-1", eventFor(s, { summary: "Different synthetic summary." })),
  );
  expectStatus(reused, 409);
  expect(codeOf(reused.body)).toBe("request_conflict");
});

it("bridge events: providerTurnId is immutable, never rewritten null to nonnull", async () => {
  const s = await bindSession(await launch());
  expectStatus(await sendEvent(s, envelope(s, "event-request-1", eventFor(s))));
  const rewritten = await sendEvent(
    s,
    envelope(s, "event-request-2", eventFor(s, { providerTurnId: "turn-1" })),
  );
  expectStatus(rewritten, 409);
  expect(codeOf(rewritten.body)).toBe("request_conflict");
});

it("bridge events: active controller credential cannot replace scoped session authority", async () => {
  const s = await bindSession(await launch());
  const reply = await post(
    s.h.base,
    "/bridge/v1/events",
    s.h.controller,
    envelope(s, "event-request-1", eventFor(s)),
  );
  expectStatus(reply, 403);
  expect(codeOf(reply.body)).toBe("scope_denied");
});

it("bridge events: pending bound-only session cannot report execution", async () => {
  const h = await launch();
  const s = await bindSession(h);
  const pendingOrigin = { ...s.origin, executionId: randomUUID(), agentId: randomUUID() };
  const pendingRegistration = BridgeSessionResultSchema.parse(
    expectStatus(
      await post(h.base, "/bridge/v1/sessions", h.controller, {
        protocolVersion: 1,
        requestId: "register-pending",
        action: "register",
        ...pendingOrigin,
        expectedIdentity: s.identity,
        requestedNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }],
        ownership: { contextOwner: "paseo-bots", captureOwner: "paseo-bots", reviewOwner: "paseo-bots" },
      }),
    ),
  );
  const pending: Session = {
    ...s,
    origin: pendingOrigin,
    sessionId: pendingRegistration.sessionId,
    token: pendingRegistration.sessionToken,
  };
  const reply = await sendEvent(pending, envelope(pending, "event-request-1", eventFor(pending), 1));
  expectStatus(reply, 409);
  expect(codeOf(reply.body)).toBe("lease_conflict");
});

it("bridge events: origin mismatch on runId is lease_conflict", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(s, envelope(s, "event-request-1", eventFor(s, { runId: "run-2" })));
  expectStatus(reply, 409);
  expect(codeOf(reply.body)).toBe("lease_conflict");
});

it("bridge events: origin mismatch on sessionEpoch is lease_conflict", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(s, envelope(s, "event-request-1", eventFor(s, { sessionEpoch: 2 })));
  expectStatus(reply, 409);
  expect(codeOf(reply.body)).toBe("lease_conflict");
});

it("bridge events: read-only consumer write attempt is scope_denied", async () => {
  const s = await bindSession(await launch([]));
  const reply = await sendEvent(s, envelope(s, "event-request-1", eventFor(s)));
  expectStatus(reply, 403);
  expect(codeOf(reply.body)).toBe("scope_denied");
});

it("bridge events: stale memory revision is revision_conflict", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(
    s,
    envelope(
      s,
      "event-request-1",
      eventFor(s, { memoryRefs: [{ id: s.alpha.id, revision: s.alpha.revision + 1 }] }),
    ),
  );
  expectStatus(reply, 409);
  expect(codeOf(reply.body)).toBe("revision_conflict");
});

it("bridge events: foreign bot memory ref is revision_conflict", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(s, envelope(s, "event-request-1", eventFor(s, { memoryRefs: [s.beta] })));
  expectStatus(reply, 409);
  expect(codeOf(reply.body)).toBe("revision_conflict");
});

it("bridge events: current granted memory in sourceRefs is accepted", async () => {
  const s = await bindSession(await launch());
  const ack = BridgeEventAckSchema.parse(
    expectStatus(
      await sendEvent(
        s,
        envelope(
          s,
          "event-request-1",
          eventFor(s, { sourceRefs: [`memory:${s.alpha.id}@${s.alpha.revision}`] }),
        ),
      ),
    ),
  );
  expect(ack.status).toBe("accepted");
});

it("bridge events: foreign memory in sourceRefs is unavailable and not committed", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(
    s,
    envelope(s, "event-request-1", eventFor(s, { sourceRefs: [`memory:${s.beta.id}@${s.beta.revision}`] })),
  );
  expectStatus(reply, 503);
  expect(codeOf(reply.body)).toBe("unavailable");
});

it("bridge events: unregistered raw path source is unavailable", async () => {
  const s = await bindSession(await launch());
  const reply = await sendEvent(
    s,
    envelope(s, "event-request-1", eventFor(s, { sourceRefs: ["/tmp/raw-transcript.txt"] })),
  );
  expectStatus(reply, 503);
  expect(codeOf(reply.body)).toBe("unavailable");
});

it("bridge events: success claim without positive verifier is unavailable and not committed", async () => {
  const s = await bindSession(await launch());
  const claim = await sendEvent(
    s,
    envelope(s, "event-request-1", eventFor(s, { outcome: { status: "succeeded", evidenceRefs: [] } })),
  );
  expectStatus(claim, 503);
  expect(codeOf(claim.body)).toBe("unavailable");
  const retry = BridgeEventAckSchema.parse(
    expectStatus(await sendEvent(s, envelope(s, "event-request-2", eventFor(s)))),
  );
  expect(retry.status).toBe("accepted");
});

it("bridge events: verifier and usage claims are unavailable", async () => {
  const s = await bindSession(await launch());
  const verifier = await sendEvent(
    s,
    envelope(
      s,
      "event-request-1",
      eventFor(s, {
        outcome: { status: "unknown", verifierId: "v1", verifierVersion: "1", evidenceRefs: [] },
      }),
    ),
  );
  expectStatus(verifier, 503);
  expect(codeOf(verifier.body)).toBe("unavailable");
  const usage = await sendEvent(
    s,
    envelope(s, "event-request-2", eventFor(s, { modelUsageRefs: ["usage-1"] })),
  );
  expectStatus(usage, 503);
  expect(codeOf(usage.body)).toBe("unavailable");
});

it("bridge events: 257th pending event is budget_exhausted and retryable", async () => {
  const s = await bindSession(await launch());
  for (let i = 0; i < 256; i++) {
    const ack = BridgeEventAckSchema.parse(
      expectStatus(
        await sendEvent(s, envelope(s, `event-request-${i}`, eventFor(s, { eventId: `event-${i}` }))),
      ),
    );
    expect(ack.status).toBe("accepted");
  }
  const overflow = await sendEvent(
    s,
    envelope(s, "event-request-overflow", eventFor(s, { eventId: "event-overflow" })),
  );
  expectStatus(overflow, 503);
  expect(codeOf(overflow.body)).toBe("budget_exhausted");
}, 60_000);

it("bridge events: released session token is denied; controller terminal replays exact ack", async () => {
  const h = await launch();
  const s = await bindSession(h);
  const release = {
    protocolVersion: 1,
    requestId: "release-1",
    action: "release",
    sessionId: s.sessionId,
    leaseVersion: 2,
  };
  const released = BridgeSessionResultSchema.parse(
    expectStatus(await post(h.base, "/bridge/v1/sessions", h.controller, release)),
  );
  expect(released.leaseVersion).toBe(3);
  expect(
    BridgeSessionResultSchema.parse(
      expectStatus(await post(h.base, "/bridge/v1/sessions", h.controller, release)),
    ),
  ).toEqual(released);
  const denied = await sendEvent(s, envelope(s, "event-request-1", eventFor(s)));
  expect(denied.status).not.toBe(200);
  const terminal = envelope(s, "terminal-request-1", eventFor(s, { eventId: "terminal-1" }));
  const ack = BridgeEventAckSchema.parse(
    expectStatus(await post(h.base, "/bridge/v1/events", h.controller, terminal)),
  );
  expect(ack.status).toBe("accepted");
  expect(
    BridgeEventAckSchema.parse(expectStatus(await post(h.base, "/bridge/v1/events", h.controller, terminal))),
  ).toEqual(ack);
});

it("bridge events: forget revokes memory refs before replay and erases event payload", async () => {
  const h = await launch();
  const s = await bindSession(h);
  const input = envelope(s, "event-request-1", eventFor(s));
  const ack = BridgeEventAckSchema.parse(expectStatus(await sendEvent(s, input)));
  expectStatus(
    await post(h.base, "/v1/mutate", h.owner, {
      requestId: "forget-alpha",
      operation: "forget",
      id: s.alpha.id,
      expectedRevision: s.alpha.revision,
      change: {},
      reason: "Erase only isolated synthetic alpha fixture",
    }),
  );
  const replay = await sendEvent(s, input);
  expectStatus(replay, 409);
  expect(codeOf(replay.body)).toBe("context_invalidated");
  await running?.stop();
  running = undefined;
  const db = openDatabase(join(h.dataDir, "memory.db")).db;
  try {
    expect(db.query("SELECT event_json FROM bridge_events WHERE event_ref=?").get(ack.eventRef)).toEqual({
      event_json: null,
    });
  } finally {
    db.close();
  }
});

it("replays a committed event after ordinary correction without admitting a new stale-source event", async () => {
  const h = await launch();
  const s = await bindSession(h);
  const event = eventFor(s, { sourceRefs: [`memory:${s.alpha.id}@${s.alpha.revision}`] });
  const input = envelope(s, "lost-ack-request", event);
  const ack = BridgeEventAckSchema.parse(expectStatus(await sendEvent(s, input)));
  expectStatus(
    await post(h.base, "/v1/mutate", h.owner, {
      requestId: "correct-event-source",
      operation: "update",
      id: s.alpha.id,
      expectedRevision: s.alpha.revision,
      change: { content: "Corrected isolated synthetic source." },
    }),
  );
  expect(BridgeEventAckSchema.parse(expectStatus(await sendEvent(s, input)))).toEqual(ack);
  const duplicate = BridgeEventAckSchema.parse(
    expectStatus(await sendEvent(s, { ...input, requestId: "new-transport" })),
  );
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.eventRef).toBe(ack.eventRef);
  const stale = await sendEvent(s, envelope(s, "new-stale-event", { ...event, eventId: "new-event" }));
  expectStatus(stale, 409);
  expect(codeOf(stale.body)).toBe("revision_conflict");
});

function sessionOrigin(agentId: string): BridgeOrigin {
  return {
    botId: "synthetic-alpha",
    runId: "run-1",
    cycleId: "cycle-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    sessionEpoch: 1,
    agentId,
    providerTurnId: null,
    purpose: "task",
  };
}

it("retains the exact externally approved Bridge contract fixture bytes", () => {
  const bytes = readFileSync(new URL("./fixtures/bridge-v1/contract.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(BRIDGE_FIXTURE_SHA256);
});
