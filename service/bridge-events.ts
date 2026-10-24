import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_DEFAULTS,
  type BridgeCycleEvent,
  type BridgeEventAck,
  BridgeEventAckSchema,
  type BridgeEventRequest,
  BridgeEventRequestSchema,
  type BridgeOrigin,
  BridgeOriginSchema,
} from "../shared/bridge";
import type { MemoryRef } from "../shared/lifecycle";
import type { Access } from "./access";
import { BridgeFailure } from "./bridge-errors";
import type { BridgeLeaseRow, BridgeSessionRow, BridgeSessions } from "./bridge-sessions";
import { canonicalBody } from "./mutations";
import type { MemoryStore } from "./store";
import { sha256 } from "./text";

export interface BridgeEventsOptions {
  db: Database;
  store: MemoryStore;
  sessions: BridgeSessions;
  now: () => string;
}

interface Source {
  kind: "memory" | "artifact";
  ref: string;
  memoryId: number | null;
  revision: number | null;
  evidenceId: string | null;
}

interface StoredEvent {
  id: number;
  event_ref: string;
  body_hash: string;
  event_json: string | null;
  processing_state: "pending" | "processed" | "rejected" | "invalidated";
}

const MEMORY_REF = /^memory:(\d+)@(\d+)$/;
const FIXED_KEYS = [
  "botId",
  "runId",
  "cycleId",
  "attemptId",
  "executionId",
  "sessionEpoch",
  "agentId",
  "purpose",
] as const;

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function unavailable(message: string): BridgeFailure {
  return new BridgeFailure("unavailable", message, true);
}

function ack(eventId: string, status: BridgeEventAck["status"], eventRef: string): BridgeEventAck {
  return BridgeEventAckSchema.parse({ protocolVersion: 1, eventId, status, eventRef });
}

/** Turn IDs do not identify events, but every payload field participates in immutable body conflicts. */
function eventBodyHash(event: BridgeCycleEvent): string {
  return sha256(canonicalBody(event));
}

export class BridgeEvents {
  constructor(private readonly options: BridgeEventsOptions) {}

  handle(header: string | null, input: BridgeEventRequest): BridgeEventAck {
    const request = BridgeEventRequestSchema.parse(input);
    return this.options.db
      .transaction(() => {
        const { session, lease } = this.options.sessions.delivery(
          header,
          request.sessionId,
          request.leaseVersion,
          { feature: "events" },
        );
        const principal = `consumer:${session.consumer_id}`;
        const transportHash = sha256(canonicalBody(request));
        const event = request.event;
        this.assertOutcome(event);
        const origin = this.correlate(event, lease);
        const access = this.options.sessions.access(session);
        if (!access.allows("write", { kind: "bot", botId: origin.botId }))
          throw new BridgeFailure("scope_denied", "Current grants do not allow the operation.");
        const existing = this.stored(session.consumer_id, event);
        if (existing) this.duplicate(existing, event);
        else this.assertMemoryRefs(access, event.memoryRefs);
        const sources = new Map(
          this.sources(access, event.sourceRefs, Boolean(existing)).map((source) => [
            `${source.kind}:${source.ref}`,
            source,
          ]),
        );
        for (const ref of event.memoryRefs) {
          const source = this.memorySource(
            access,
            `memory:${ref.id}@${ref.revision}`,
            ref,
            Boolean(existing),
          );
          sources.set(`memory:${source.ref}`, source);
        }
        const replay = this.replay(principal, request.requestId, transportHash);
        if (replay) {
          if (!existing)
            throw new BridgeFailure("context_invalidated", "The committed source event is unavailable.");
          this.duplicate(existing, event);
          return replay;
        }
        const result = existing
          ? this.duplicate(existing, event)
          : this.insert(session, lease, event, [...sources.values()]);
        this.record(principal, request.requestId, transportHash, result);
        return result;
      })
      .immediate();
  }

  private replay(principal: string, requestId: string, bodyHash: string): BridgeEventAck | null {
    const row = this.options.db
      .query<{ body_hash: string; result_json: string }, [string, string]>(
        `SELECT body_hash,result_json FROM bridge_requests
         WHERE principal_id = ? AND endpoint = 'events' AND request_id = ?`,
      )
      .get(principal, requestId);
    if (!row) return null;
    if (row.body_hash !== bodyHash)
      throw new BridgeFailure(
        "request_conflict",
        "The event request identifier was reused with changed content.",
      );
    return BridgeEventAckSchema.parse(JSON.parse(row.result_json));
  }

  /** Fixed origin fields must match the originating lease; providerTurnId may be first observed here. */
  private correlate(event: BridgeCycleEvent, lease: BridgeLeaseRow): BridgeOrigin {
    const origin = BridgeOriginSchema.parse(JSON.parse(lease.origin_json));
    const fixedMismatch = FIXED_KEYS.some((key) => origin[key] !== event[key]);
    const turnMismatch = origin.providerTurnId !== null && origin.providerTurnId !== event.providerTurnId;
    if (fixedMismatch || turnMismatch)
      throw new BridgeFailure("lease_conflict", "The event does not match the originating lease.");
    return origin;
  }

  /** Verifier, evidence, and usage claims need the B08 positive-verifier gate, which is not shipped. */
  private assertOutcome(event: BridgeCycleEvent): void {
    const { outcome, modelUsageRefs } = event;
    const claimsVerifier = present(outcome.verifierId) || present(outcome.verifierVersion);
    if (
      outcome.status === "succeeded" ||
      claimsVerifier ||
      outcome.evidenceRefs.length > 0 ||
      modelUsageRefs.length > 0
    )
      throw unavailable(
        "Verified success, verifier, evidence, and usage claims need the positive verifier gate, which is not available.",
      );
  }

  private assertMemoryRefs(access: Access, refs: BridgeCycleEvent["memoryRefs"]): void {
    for (const ref of refs) {
      const row = this.options.store.getVisible(access, [ref.id])[0];
      if (!row || row.record_revision !== ref.revision)
        throw new BridgeFailure("revision_conflict", "Reload the current canonical revision.");
    }
  }

  private sources(access: Access, refs: string[], historical: boolean): Source[] {
    const out: Source[] = [];
    for (const ref of new Set(refs)) {
      const memory = MEMORY_REF.exec(ref);
      out.push(
        memory
          ? this.memorySource(access, ref, { id: Number(memory[1]), revision: Number(memory[2]) }, historical)
          : this.artifactSource(access, ref),
      );
    }
    return out;
  }

  private memorySource(access: Access, ref: string, memory: MemoryRef, historical = false): Source {
    const { id: memoryId, revision } = memory;
    if (historical) {
      if (!this.options.store.provenance.sourceReadable(access, "memory", ref))
        throw unavailable("The committed source revision is no longer readable.");
      return { kind: "memory", ref, memoryId, revision, evidenceId: null };
    }
    const row = this.options.store.getVisible(access, [memoryId])[0];
    if (!row || row.record_revision !== revision)
      throw unavailable("Source memory is not readable at the exact revision.");
    return { kind: "memory", ref, memoryId, revision, evidenceId: this.evidence(access, "memory", ref) };
  }

  private artifactSource(access: Access, ref: string): Source {
    return {
      kind: "artifact",
      ref,
      memoryId: null,
      revision: null,
      evidenceId: this.evidence(access, "artifact", ref),
    };
  }

  /** Resolution validates real current sources without inventing or duplicating evidence records. */
  private evidence(access: Access, kind: "memory" | "artifact", ref: string): null {
    if (!this.options.store.provenance.currentSource(access, kind, ref))
      throw unavailable("Source reference is not registered in current Memory provenance.");
    return null;
  }

  private stored(consumerId: string, event: BridgeCycleEvent): StoredEvent | null {
    return (
      this.options.db
        .query<StoredEvent, [string, string, number, string]>(
          `SELECT id,event_ref,body_hash,event_json,processing_state FROM bridge_events
           WHERE consumer_id = ? AND execution_id = ? AND session_epoch = ? AND event_id = ?`,
        )
        .get(consumerId, event.executionId, event.sessionEpoch, event.eventId) ?? null
    );
  }

  private duplicate(row: StoredEvent, event: BridgeCycleEvent): BridgeEventAck {
    if (row.processing_state === "invalidated")
      throw new BridgeFailure("context_invalidated", "The source event was forgotten.");
    if (row.body_hash !== eventBodyHash(event))
      throw new BridgeFailure("request_conflict", "The source event body changed for this event identity.");
    return ack(event.eventId, "duplicate", row.event_ref);
  }

  private insert(
    session: BridgeSessionRow,
    lease: BridgeLeaseRow,
    event: BridgeCycleEvent,
    sources: Source[],
  ): BridgeEventAck {
    const { n } = this.options.db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM bridge_events WHERE processing_state = 'pending'`)
      .get() ?? { n: 0 };
    if (n >= BRIDGE_DEFAULTS.maxPendingEvents)
      throw new BridgeFailure("budget_exhausted", "Transient bounded capacity is occupied.", true);
    const eventRef = `bev_${randomUUID()}`;
    const { lastInsertRowid } = this.options.db
      .query(
        `INSERT INTO bridge_events(event_ref,consumer_id,session_id,execution_id,session_epoch,event_id,
           origin_lease_version,body_hash,event_json,source_ref,processing_state,created_at,last_error)
         VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,NULL)`,
      )
      .run(
        eventRef,
        session.consumer_id,
        session.session_id,
        event.executionId,
        event.sessionEpoch,
        event.eventId,
        lease.lease_version,
        eventBodyHash(event),
        JSON.stringify(event),
        sources[0]?.ref ?? null,
        this.options.now(),
      );
    for (const source of sources)
      this.options.db
        .query(
          `INSERT INTO bridge_event_sources(event_id,source_kind,source_ref,memory_id,revision,evidence_id)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          Number(lastInsertRowid),
          source.kind,
          source.ref,
          source.memoryId,
          source.revision,
          source.evidenceId,
        );
    return ack(event.eventId, "accepted", eventRef);
  }

  private record(principal: string, requestId: string, bodyHash: string, result: BridgeEventAck): void {
    this.options.db
      .query(
        `INSERT INTO bridge_requests(principal_id,endpoint,request_id,body_hash,result_json,created_at)
         VALUES(?,'events',?,?,?,?)`,
      )
      .run(principal, requestId, bodyHash, JSON.stringify(result), this.options.now());
  }
}
