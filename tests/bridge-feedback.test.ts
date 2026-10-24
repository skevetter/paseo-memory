// Controlled HTTP regression for bridge feedback (M07). Real startService HTTP, owner
// configure/save/bridge-create/bridge-open, controller register/bind, session credentials,
// and native sqlite-vec. Embedder is the deterministic hashEmbedder seam: this is a
// controlled local-backend proof, not a native SDK proof and not a retrieval-quality claim.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeDiscoverySchema } from "../server/bridge-discovery";
import { Access } from "../service/access";
import { type RunningService, serviceKey, startService } from "../service/app";
import { openDatabase } from "../service/sqlite";
import { sha256 } from "../service/text";
import {
  BridgeContextResultSchema,
  type BridgeErrorCode,
  BridgeErrorSchema,
  BridgeFeedbackAckSchema,
  type BridgeFeedbackRequest,
  type BridgeOrigin,
  BridgeSessionResultSchema,
} from "../shared/bridge";
import type { MemoryRef } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder, tempDir } from "./helpers";

const MemoryRefSchema = z.object({ id: z.number(), revision: z.number() });
const BUDGET = { maxTokens: 4096, maxChars: 6000, maxLatencyMs: 2000 };

interface Bound {
  sessionId: string;
  sessionToken: string;
  retrievalId: string;
  agentId: string;
  origin: BridgeOrigin;
  alpha: MemoryRef;
  beta: MemoryRef;
  global: MemoryRef;
}

interface Sent {
  status: number;
  json: unknown;
}

let service: RunningService;
let serviceUp = false;
let dataDir = "";
let base = "";
let ownerKey = "";
let controllerHeaders: Record<string, string> = {};
let fixture: Bound;

async function send(path: string, headers: Record<string, string>, body: unknown): Promise<Sent> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function ownerHeaders(): Record<string, string> {
  return { [SERVICE_KEY_HEADER]: ownerKey };
}

async function saveMemory(
  scope: "bot" | "global",
  botId: string | null,
  title: string,
  content: string,
): Promise<MemoryRef> {
  const res = await send("/v1/save", ownerHeaders(), {
    title,
    content,
    type: "note",
    scope,
    botId,
    paseoProjectId: null,
    project: null,
    pinned: false,
  });
  expect(res.status).toBe(200);
  return MemoryRefSchema.parse(z.object({ memoryRef: MemoryRefSchema }).parse(res.json).memoryRef);
}

async function boot(): Promise<Bound> {
  dataDir = tempDir("pm-bridge-feedback-");
  service = await startService({
    dataDir,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  serviceUp = true;
  await service.modelsReady();
  base = `http://127.0.0.1:${service.port}`;
  ownerKey = serviceKey(service.secret);

  const configured = await send("/v1/configure", ownerHeaders(), {
    ...DEFAULT_RUNTIME,
    detailLevel: "summaries",
    bridge: {
      enabled: true,
      consumers: [
        {
          id: "synthetic-controller",
          readNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }, { kind: "global" }],
          writeNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }],
        },
      ],
    },
  });
  expect(configured.status).toBe(200);

  const alpha = await saveMemory(
    "bot",
    "synthetic-alpha",
    "SYNTHETIC_ALPHA_RECORD",
    "Synthetic alpha is an isolated QA statement.",
  );
  const beta = await saveMemory(
    "bot",
    "synthetic-beta",
    "SYNTHETIC_BETA_CANARY",
    "Synthetic foreign bot canary.",
  );
  const global = await saveMemory("global", null, "SYNTHETIC_GLOBAL_CANARY", "Synthetic global canary.");
  await service.store.indexPending();

  const descriptor = BridgeDiscoverySchema.parse(
    JSON.parse(readFileSync(join(dataDir, "bridge-v1.json"), "utf8")),
  );
  const controller = descriptor.controllers.find((entry) => entry.consumerId === "synthetic-controller");
  if (!controller) throw new Error("The configured controller was not published.");
  const credential = z
    .object({ consumerId: z.string(), credential: z.string() })
    .parse(JSON.parse(readFileSync(join(dataDir, controller.credentialRef), "utf8")));
  controllerHeaders = bearer(credential.credential);

  return openSession(alpha, beta, global);
}

async function openSession(alpha: MemoryRef, beta: MemoryRef, global: MemoryRef): Promise<Bound> {
  const agentId = randomUUID();
  const identity = { workspaceId: null, provider: "omp", cwd: dataDir };
  const origin: BridgeOrigin = {
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
  const registeredRes = await send("/bridge/v1/sessions", controllerHeaders, {
    protocolVersion: 1,
    requestId: "register-1",
    action: "register",
    ...origin,
    expectedIdentity: identity,
    requestedNamespaces: [{ kind: "bot", botId: "synthetic-alpha" }],
    ownership: { contextOwner: "paseo-bots", captureOwner: "paseo-bots", reviewOwner: "paseo-bots" },
  });
  expect(registeredRes.status).toBe(200);
  const registered = BridgeSessionResultSchema.parse(registeredRes.json);

  const contextRes = await send("/bridge/v1/context", bearer(registered.sessionToken), {
    protocolVersion: 1,
    requestId: "context-1",
    sessionId: registered.sessionId,
    leaseVersion: 1,
    query: "",
    namespaceFilter: [{ kind: "bot", botId: "synthetic-alpha" }],
    recordKinds: ["fact"],
    budget: BUDGET,
  });
  expect(contextRes.status).toBe(200);
  const context = BridgeContextResultSchema.parse(contextRes.json);
  expect(context.memoryRefs).toEqual([alpha]);

  const staged = await send("/v1/bridge-create", ownerHeaders(), {
    bootstrapRef: registered.bootstrapRef,
    identity,
    configHash: sha256(JSON.stringify({ provider: "omp", cwd: dataDir, systemPrompt: context.contextText })),
  });
  expect(staged.status).toBe(200);

  const boundRes = await send("/bridge/v1/sessions", controllerHeaders, {
    protocolVersion: 1,
    requestId: "bind-1",
    action: "bind",
    sessionId: registered.sessionId,
    leaseVersion: 1,
    actualAgentId: agentId,
    observedIdentity: identity,
    sessionEpoch: 1,
    bootstrapRef: registered.bootstrapRef,
  });
  expect(boundRes.status).toBe(200);
  const bound = BridgeSessionResultSchema.parse(boundRes.json);
  expect(bound.leaseVersion).toBe(2);

  const opened = await send("/v1/bridge-open", ownerHeaders(), {
    agentId,
    identity,
    purpose: "interactive",
    reason: "create",
  });
  expect(opened.status).toBe(200);

  return {
    sessionId: bound.sessionId,
    sessionToken: bound.sessionToken,
    retrievalId: context.retrievalId,
    agentId,
    origin,
    alpha,
    beta,
    global,
  };
}

function feedbackBody(overrides: Partial<BridgeFeedbackRequest> = {}): BridgeFeedbackRequest {
  return {
    protocolVersion: 1,
    requestId: "feedback-1",
    sessionId: fixture.sessionId,
    leaseVersion: 2,
    retrievalId: fixture.retrievalId,
    runId: "run-1",
    cycleId: "cycle-1",
    delivery: { status: "attached", executionId: "execution-1" },
    assessments: [{ memoryRef: fixture.alpha, signal: "helpful", basis: "agent_report", evidenceRefs: [] }],
    ...overrides,
  };
}

function postFeedback(body: BridgeFeedbackRequest): Promise<Sent> {
  return send("/bridge/v1/feedback", bearer(fixture.sessionToken), body);
}

// Asserts a bridge rejection by error code without pinning the HTTP status.
function expectBridgeCode(res: Sent, code: BridgeErrorCode): void {
  expect(res.status).not.toBe(200);
  expect(BridgeErrorSchema.parse(res.json).error.code).toBe(code);
}

beforeEach(async () => {
  fixture = await boot();
});

afterEach(async () => {
  try {
    if (serviceUp) await service.stop();
  } finally {
    serviceUp = false;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("replays the exact receipt and reports a new-id repeat as duplicate", async () => {
  const first = await postFeedback(feedbackBody());
  expect(first.status).toBe(200);
  const acked = BridgeFeedbackAckSchema.parse(first.json);
  expect(acked.status).toBe("accepted");

  const replay = await postFeedback(feedbackBody());
  expect(BridgeFeedbackAckSchema.parse(replay.json)).toEqual(acked);

  const repeat = await postFeedback(feedbackBody({ requestId: "feedback-2" }));
  expect(BridgeFeedbackAckSchema.parse(repeat.json).status).toBe("duplicate");
});

it("rejects a reused request id whose body differs", async () => {
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  const changed = await postFeedback(
    feedbackBody({ delivery: { status: "discarded", executionId: "execution-1" } }),
  );
  expectBridgeCode(changed, "request_conflict");
});

it("rejects a changed signal on the same memory and keeps the original receipt intact", async () => {
  const first = await postFeedback(feedbackBody());
  expect(first.status).toBe(200);
  const changed = await postFeedback(
    feedbackBody({
      requestId: "feedback-2",
      assessments: [{ memoryRef: fixture.alpha, signal: "harmful", basis: "agent_report", evidenceRefs: [] }],
    }),
  );
  expectBridgeCode(changed, "request_conflict");
  const replay = await postFeedback(feedbackBody());
  expect(BridgeFeedbackAckSchema.parse(replay.json)).toEqual(BridgeFeedbackAckSchema.parse(first.json));
});

it("rejects a delivery report that conflicts with the stored attached state", async () => {
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  const discarded = await postFeedback(
    feedbackBody({
      requestId: "feedback-2",
      delivery: { status: "discarded", executionId: "execution-1" },
      assessments: [],
    }),
  );
  expectBridgeCode(discarded, "request_conflict");
});

it("accepts new delivery facts in a second retrieval alongside a new memory assessment", async () => {
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  const gamma = await saveMemory(
    "bot",
    "synthetic-alpha",
    "SYNTHETIC_ALPHA_SECOND",
    "Second synthetic alpha statement.",
  );
  await service.store.indexPending();
  const secondRes = await send("/bridge/v1/context", bearer(fixture.sessionToken), {
    protocolVersion: 1,
    requestId: "context-2",
    sessionId: fixture.sessionId,
    leaseVersion: 2,
    query: "",
    namespaceFilter: [{ kind: "bot", botId: "synthetic-alpha" }],
    recordKinds: ["fact"],
    budget: BUDGET,
  });
  expect(secondRes.status).toBe(200);
  const second = BridgeContextResultSchema.parse(secondRes.json);
  expect(second.memoryRefs).toContainEqual(gamma);

  const mixed = await postFeedback(
    feedbackBody({
      requestId: "feedback-mixed",
      retrievalId: second.retrievalId,
      assessments: [
        { memoryRef: fixture.alpha, signal: "helpful", basis: "agent_report", evidenceRefs: [] },
        { memoryRef: gamma, signal: "applied", basis: "agent_report", evidenceRefs: [] },
      ],
    }),
  );
  expect(BridgeFeedbackAckSchema.parse(mixed.json).status).toBe("accepted");
});

it("refuses a foreign bot memory in an assessment", async () => {
  const foreign = await postFeedback(
    feedbackBody({
      requestId: "feedback-foreign",
      assessments: [{ memoryRef: fixture.beta, signal: "helpful", basis: "agent_report", evidenceRefs: [] }],
    }),
  );
  expectBridgeCode(foreign, "scope_denied");
});

it("refuses an assessment whose revision is not the delivered revision", async () => {
  const stale = await postFeedback(
    feedbackBody({
      requestId: "feedback-revision",
      assessments: [
        {
          memoryRef: { id: fixture.alpha.id, revision: fixture.alpha.revision + 1 },
          signal: "helpful",
          basis: "agent_report",
          evidenceRefs: [],
        },
      ],
    }),
  );
  expect(stale.status).not.toBe(200);
});

it("refuses task-purpose human and validator claims with unavailable", async () => {
  const bases: Array<"human" | "validator"> = ["human", "validator"];
  for (const basis of bases) {
    const claim = await postFeedback(
      feedbackBody({
        requestId: `feedback-${basis}`,
        assessments: [{ memoryRef: fixture.alpha, signal: "helpful", basis, evidenceRefs: [] }],
      }),
    );
    expectBridgeCode(claim, "unavailable");
  }
});

it("refuses replay after source forget, before the stored receipt is returned", async () => {
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  const preview = await send("/v1/forget-preview", ownerHeaders(), { id: fixture.alpha.id });
  expect(preview.status).toBe(200);
  const forgot = await send("/v1/mutate", ownerHeaders(), {
    requestId: "forget-alpha",
    operation: "forget",
    id: fixture.alpha.id,
    expectedRevision: fixture.alpha.revision,
    change: {},
    reason: "Erase isolated synthetic alpha fixture",
  });
  expect(forgot.status).toBe(200);
  const replay = await postFeedback(feedbackBody());
  expectBridgeCode(replay, "context_invalidated");
});

it("settles prepared usage exactly once across replay and duplicate", async () => {
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  expect((await postFeedback(feedbackBody())).status).toBe(200);
  expect((await postFeedback(feedbackBody({ requestId: "feedback-2" }))).status).toBe(200);
  await service.stop();
  serviceUp = false;
  const db = openDatabase(join(dataDir, "memory.db")).db;
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM model_usage WHERE attempt_id=? AND source_sequence=1",
    )
    .get(fixture.retrievalId);
  db.close();
  expect(row?.n).toBe(1);
});

it("rejects feedback after the controller releases the session", async () => {
  const released = await send("/bridge/v1/sessions", controllerHeaders, {
    protocolVersion: 1,
    requestId: "release-1",
    action: "release",
    sessionId: fixture.sessionId,
    leaseVersion: 2,
  });
  expect(released.status).toBe(200);
  const after = await postFeedback(feedbackBody({ requestId: "feedback-after-release" }));
  expect(after.status).not.toBe(200);
  expect(["lease_expired", "lease_conflict", "unauthorized"]).toContain(
    BridgeErrorSchema.parse(after.json).error.code,
  );
});

it("records a delivered historical revision without changing current hints or factual verification", async () => {
  const changed = await send("/v1/mutate", ownerHeaders(), {
    requestId: "correct-alpha",
    operation: "update",
    id: fixture.alpha.id,
    expectedRevision: fixture.alpha.revision,
    change: { content: "Corrected isolated QA statement." },
  });
  expect(changed.status).toBe(200);
  const currentRef = z.object({ memoryRef: MemoryRefSchema }).parse(changed.json).memoryRef;
  const before = service.store.getVisible(Access.owner(), [fixture.alpha.id])[0];
  if (!before) throw new Error("Corrected current record missing.");
  const reply = await postFeedback(feedbackBody());
  expect(reply.status).toBe(200);
  expect(BridgeFeedbackAckSchema.parse(reply.json).status).toBe("accepted");
  const after = service.store.getVisible(Access.owner(), [fixture.alpha.id])[0];
  if (!after) throw new Error("Feedback removed the current record.");
  expect(after.record_revision).toBe(currentRef.revision);
  expect(after.application_count).toBe(before.application_count);
  expect(after.validated_helpful_count).toBe(before.validated_helpful_count);
  expect(after.validated_harmful_count).toBe(before.validated_harmful_count);
  expect(after.verified_at).toBe(before.verified_at);
  expect(after.verification_status).toBe(before.verification_status);
  expect(after.content).toBe("Corrected isolated QA statement.");
  const db = openDatabase(join(dataDir, "memory.db")).db;
  try {
    const row = db
      .query<{ revision: number; validated: number }, [number]>(
        "SELECT revision,validated FROM memory_feedback WHERE memory_id=?",
      )
      .get(fixture.alpha.id);
    expect(row).toEqual({ revision: fixture.alpha.revision, validated: 0 });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

it("allows controller-only terminal feedback after persisted expiry without extending the fixed deadline", async () => {
  // External fixture writes simulate an elapsed lease; no host epoch or provider observation is inferred.
  const db = openDatabase(join(dataDir, "memory.db")).db;
  try {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    db.query("UPDATE bridge_sessions SET expires_at=? WHERE session_id=?").run(expiredAt, fixture.sessionId);
    db.query("UPDATE bridge_leases SET expires_at=? WHERE session_id=? AND lease_version=2").run(
      expiredAt,
      fixture.sessionId,
    );
    const terminal = feedbackBody();
    const reply = await send("/bridge/v1/feedback", controllerHeaders, terminal);
    expect(reply.status).toBe(200);
    const ack = BridgeFeedbackAckSchema.parse(reply.json);
    expect(ack.status).toBe("accepted");
    const deadline = db
      .query<{ terminal_deadline: string }, [string]>(
        "SELECT terminal_deadline FROM bridge_leases WHERE session_id=? AND lease_version=2",
      )
      .get(fixture.sessionId)?.terminal_deadline;
    expect(deadline).toBe(new Date(Date.parse(expiredAt) + 86400_000).toISOString());
    expect(
      BridgeFeedbackAckSchema.parse((await send("/bridge/v1/feedback", controllerHeaders, terminal)).json),
    ).toEqual(ack);
    expect(
      db
        .query<{ terminal_deadline: string }, [string]>(
          "SELECT terminal_deadline FROM bridge_leases WHERE session_id=? AND lease_version=2",
        )
        .get(fixture.sessionId)?.terminal_deadline,
    ).toBe(deadline);
    expectBridgeCode(await postFeedback(feedbackBody({ requestId: "expired-scoped" })), "lease_expired");
    db.query("UPDATE bridge_leases SET terminal_deadline=? WHERE session_id=? AND lease_version=2").run(
      expiredAt,
      fixture.sessionId,
    );
    expectBridgeCode(await send("/bridge/v1/feedback", controllerHeaders, terminal), "lease_expired");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
