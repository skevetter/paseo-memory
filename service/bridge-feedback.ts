import type { Database } from "bun:sqlite";
import {
  type BridgeConsumerPolicy,
  BridgeConsumerPolicySchema,
  BridgeErrorCodeSchema,
  type BridgeFeedbackAck,
  BridgeFeedbackAckSchema,
  type BridgeFeedbackRequest,
  type BridgeOrigin,
  BridgeOriginSchema,
} from "../shared/bridge";
import type { ModelUsageInput } from "../shared/resources";
import type { BridgeContexts } from "./bridge-context";
import { BridgeFailure } from "./bridge-errors";
import type { BridgeSessionRow, BridgeSessions } from "./bridge-sessions";
import { canonicalBody, MutationError, type MutationPrincipal } from "./mutations";
import type { MemoryStore } from "./store";
import { sha256 } from "./text";

export interface BridgeFeedbackOptions {
  db: Database;
  store: MemoryStore;
  sessions: BridgeSessions;
  contexts: BridgeContexts;
  now: () => string;
}

type DeliveryStatus = "attached" | "discarded" | "unknown";
type Assessment = BridgeFeedbackRequest["assessments"][number];
type DeliveryState = "assembled" | DeliveryStatus;

interface Ctx {
  header: string | null;
  input: BridgeFeedbackRequest;
  session: BridgeSessionRow;
  origin: BridgeOrigin;
  allowPending: boolean;
}

interface ContextRow {
  retrieval_id: string;
  session_id: string;
  session_epoch: number;
  lease_version: number;
  delivery_state: DeliveryState;
  delivery_hash: string | null;
  invalidated_at: string | null;
}

interface ReceiptRow {
  body_hash: string;
  result_json: string;
}

interface PreparedRow {
  attemptId: string;
  provenance: ModelUsageInput["provenance"];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: number | null;
  currency: string | null;
  sourceEventId: string | null;
  retrievalId: string | null;
  jobId: string | null;
  estimator: string | null;
  durationMs: number | null;
}

const PREPARED_SQL = `SELECT attempt_id AS attemptId, provenance, model, input_tokens AS inputTokens,
    output_tokens AS outputTokens, cost_amount AS costAmount, currency, source_event_id AS sourceEventId,
    retrieval_id AS retrievalId, job_id AS jobId, estimator, duration_ms AS durationMs
  FROM model_usage
  WHERE producer_id='memory_runtime' AND event_id=? AND attempt_id=? AND retrieval_id=?
    AND stage='memory_input' AND status='prepared' AND source_sequence=0
    AND provenance IN ('local_exact','estimate')`;

function checkOrigin(origin: BridgeOrigin, input: BridgeFeedbackRequest): void {
  if (
    input.runId !== origin.runId ||
    input.cycleId !== origin.cycleId ||
    (input.delivery !== undefined && input.delivery.executionId !== origin.executionId)
  )
    throw new BridgeFailure("scope_denied", "Feedback does not match the bridge origin.");
}

function checkAssessments(assessments: readonly Assessment[]): void {
  if (assessments.some((assessment) => assessment.basis !== "agent_report"))
    throw new BridgeFailure("unavailable", "Non-agent_report feedback needs an external trusted resolver.");
}

function assessmentEventId(ctx: Ctx, assessment: Assessment): string {
  return `bridge:${sha256(
    canonicalBody({
      executionId: ctx.origin.executionId,
      sessionEpoch: ctx.session.session_epoch,
      runId: ctx.input.runId,
      cycleId: ctx.input.cycleId,
      memoryRef: assessment.memoryRef,
      basis: assessment.basis,
    }),
  )}`;
}

// Authenticated bridge feedback. One immediate transaction covers auth, receipt,
// context/delivery state, usage settlement, and feedback writes, so any failure
// rolls back the whole request and the same requestId can be retried.
export class BridgeFeedback {
  constructor(private readonly options: BridgeFeedbackOptions) {}

  handle(header: string | null, input: BridgeFeedbackRequest): BridgeFeedbackAck {
    try {
      return this.options.db.transaction(() => this.commit(header, input)).immediate();
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      const parsed = BridgeErrorCodeSchema.safeParse(error.code);
      throw new BridgeFailure(parsed.success ? parsed.data : "unavailable", error.message);
    }
  }

  private commit(header: string | null, input: BridgeFeedbackRequest): BridgeFeedbackAck {
    const allowPending =
      input.assessments.length === 0 &&
      (input.delivery?.status === "discarded" || input.delivery?.status === "unknown");
    const { session, lease } = this.options.sessions.delivery(header, input.sessionId, input.leaseVersion, {
      feature: "feedback",
      allowPending,
    });
    const principalId = `consumer:${session.consumer_id}`;
    const bodyHash = sha256(canonicalBody(input));
    const receipt = this.options.db
      .query<ReceiptRow, [string, string]>(
        "SELECT body_hash, result_json FROM bridge_requests WHERE principal_id=? AND endpoint='feedback' AND request_id=?",
      )
      .get(principalId, input.requestId);
    if (receipt && receipt.body_hash !== bodyHash)
      throw new BridgeFailure("request_conflict", "This feedback request id already has a different body.");

    const ctx: Ctx = {
      header,
      input,
      session,
      origin: BridgeOriginSchema.parse(JSON.parse(lease.origin_json)),
      allowPending,
    };
    checkOrigin(ctx.origin, input);
    this.options.contexts.assertIssued(input.retrievalId, session, input.leaseVersion);
    const context = this.loadContext(input.retrievalId);
    checkAssessments(input.assessments);

    const deliveryRecorded = this.recordDelivery(context, input);
    const assessed = this.recordAssessments(ctx);

    if (receipt) {
      if (deliveryRecorded || assessed)
        throw new BridgeFailure(
          "context_invalidated",
          "The original feedback facts are no longer available for replay.",
        );
      return this.replay(receipt, bodyHash);
    }
    const ack = BridgeFeedbackAckSchema.parse({
      protocolVersion: 1,
      retrievalId: input.retrievalId,
      status: !deliveryRecorded && !assessed ? "duplicate" : "accepted",
    });
    this.options.db
      .query(
        "INSERT INTO bridge_requests (principal_id, endpoint, request_id, body_hash, result_json, created_at) VALUES (?, 'feedback', ?, ?, ?, ?)",
      )
      .run(principalId, input.requestId, bodyHash, JSON.stringify(ack), this.options.now());
    return ack;
  }

  private replay(receipt: ReceiptRow, bodyHash: string): BridgeFeedbackAck {
    if (receipt.body_hash !== bodyHash)
      throw new BridgeFailure("request_conflict", "This feedback request id already has a different body.");
    return BridgeFeedbackAckSchema.parse(JSON.parse(receipt.result_json));
  }

  private loadContext(retrievalId: string): ContextRow {
    const context = this.options.db
      .query<ContextRow, [string]>(
        `SELECT retrieval_id, session_id, session_epoch, lease_version, delivery_state, delivery_hash, invalidated_at
         FROM bridge_contexts WHERE retrieval_id=?`,
      )
      .get(retrievalId);
    if (!context) throw new BridgeFailure("context_invalidated", "The bridge context is no longer valid.");
    return context;
  }

  // Returns true when this call moved the context from assembled to a delivery state.
  private recordDelivery(context: ContextRow, input: BridgeFeedbackRequest): boolean {
    if (!input.delivery) return false;
    const { status, executionId, promptFingerprint } = input.delivery;
    const hash = sha256(canonicalBody({ status, executionId, promptFingerprint: promptFingerprint ?? null }));
    if (context.delivery_state !== "assembled") {
      if (context.delivery_state !== status || context.delivery_hash !== hash)
        throw new BridgeFailure("request_conflict", "This context already has a different delivery report.");
      return false;
    }
    this.options.db
      .query("UPDATE bridge_contexts SET delivery_state=?, delivery_hash=? WHERE retrieval_id=?")
      .run(status, hash, context.retrieval_id);
    this.settle(context.retrieval_id, status);
    return true;
  }

  // Returns true when any assessment wrote a new feedback event.
  private recordAssessments(ctx: Ctx): boolean {
    if (ctx.input.assessments.length === 0) return false;
    const principal = this.principal(ctx);
    let changed = false;
    for (const assessment of ctx.input.assessments) {
      const input = {
        eventId: assessmentEventId(ctx, assessment),
        retrievalId: ctx.input.retrievalId,
        memoryRef: assessment.memoryRef,
        signal: assessment.signal,
        basis: assessment.basis,
        evidenceRefs: assessment.evidenceRefs,
      };
      this.options.store.feedback.assertDelivery(principal, input);
      const prior = this.options.db
        .query<{ retrieval_id: string }, [string, string]>(
          "SELECT retrieval_id FROM memory_feedback WHERE producer_id=? AND event_id=?",
        )
        .get(principal.id, input.eventId);
      // The same source assessment can be redelivered with a new fragment. Authorize
      // that delivery above, but keep the original fact's immutable receipt identity.
      const result = this.options.store.feedback.record(principal, {
        ...input,
        retrievalId: prior?.retrieval_id ?? input.retrievalId,
      });
      if (!result.duplicate) changed = true;
    }
    return changed;
  }

  private settle(retrievalId: string, status: DeliveryStatus): void {
    const prepared = this.options.db
      .query<PreparedRow, [string, string, string]>(PREPARED_SQL)
      .get(`prepared:${retrievalId}`, retrievalId, retrievalId);
    if (!prepared)
      throw new BridgeFailure(
        "context_invalidated",
        "No prepared usage fragment matches this bridge context.",
      );
    this.options.store.usage.record("memory_runtime", {
      ...prepared,
      eventId: `settled:${sha256(retrievalId)}`,
      sourceSequence: 1,
      stage: "memory_input",
      status,
    });
  }

  private principal(ctx: Ctx): MutationPrincipal {
    const { header, input, session, origin, allowPending } = ctx;
    const policy: BridgeConsumerPolicy = BridgeConsumerPolicySchema.parse(JSON.parse(session.grants_json));
    return {
      id: `bridge:${session.consumer_id}:${origin.executionId}:${session.session_epoch}`,
      actorId: `bridge:${session.consumer_id}`,
      agentId: session.actual_agent_id,
      provider: this.options.sessions.identity(session).provider,
      access: this.options.sessions.access(session),
      defaultNamespace: { kind: "bot", botId: origin.botId },
      assertCurrent: () => {
        this.options.sessions.delivery(header, session.session_id, input.leaseVersion, {
          feature: "feedback",
          allowPending,
        });
      },
      allowedMutations: policy.mutationPurposes.includes(origin.purpose) ? policy.mutations : [],
    };
  }
}
