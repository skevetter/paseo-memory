import type { Database } from "bun:sqlite";
import type { Evidence, MemoryRef } from "../shared/lifecycle";
import { namespaceOf } from "../shared/namespaces";
import {
  type FeedbackInput,
  FeedbackInputSchema,
  type FeedbackResult,
  type ParsedFeedback,
} from "../shared/resources";
import { currentLifecycleSql, type Lifecycle } from "./lifecycle";
import { assertCurrentPrincipal, canonicalBody, MutationError, type MutationPrincipal } from "./mutations";
import type { Provenance } from "./provenance";
import type { MemoryRow } from "./store";
import { sha256 } from "./text";

interface FeedbackOptions {
  provenance: Provenance;
  lifecycle: Lifecycle;
  now: () => string;
  changed: () => void;
}
interface PriorFeedback {
  request_body_hash: string;
  result: string;
}
type FeedbackCounter = "application_count" | "validated_helpful_count" | "validated_harmful_count";
interface HintCounts {
  applications: number;
  validatedHelpful: number;
  validatedHarmful: number;
}
interface HintRow extends HintCounts {
  memory_id: number;
}

export class MemoryFeedback {
  constructor(
    private readonly db: Database,
    private readonly options: FeedbackOptions,
  ) {}
  record(principal: MutationPrincipal, raw: FeedbackInput): FeedbackResult {
    this.expire();
    const parsed = FeedbackInputSchema.parse(raw);
    const input = { ...parsed, evidenceRefs: [...new Set(parsed.evidenceRefs)].sort() };
    const hash = sha256(canonicalBody(input));
    const result = this.db.transaction(() => this.commit(principal, input, hash)).immediate();
    if (!result.duplicate) this.options.changed();
    return result;
  }
  assertDelivery(principal: MutationPrincipal, raw: FeedbackInput): void {
    const input = FeedbackInputSchema.parse(raw);
    const context = assertCurrentPrincipal(this.options.lifecycle, principal);
    this.authorizeReference(principal, input.memoryRef);
    this.authorizeEvidence(principal, input);
    if (!this.disclosed(principal, input, context.nonce))
      throw new MutationError("scope_denied", "The canonical reference was not disclosed in this retrieval.");
  }

  expire(): void {
    const at = this.options.now();
    const where = "validated=1 AND support_valid_until IS NOT NULL AND support_valid_until<=?";
    if (!this.db.query(`SELECT 1 FROM memory_feedback WHERE ${where} LIMIT 1`).get(at)) return;
    const changed = this.db
      .transaction(() => {
        const rows = this.db
          .query<StoredFeedback, [string]>(`SELECT * FROM memory_feedback WHERE ${where}`)
          .all(at);
        for (const row of rows) retractAssessment(this.db, row, "invalidate");
        return rows.length;
      })
      .immediate();
    if (changed) this.options.changed();
  }

  projectCurrentHints(rows: MemoryRow[]): void {
    if (rows.length === 0 || !this.supportPropagationPending()) return;
    const ids = JSON.stringify(rows.map((row) => row.id));
    const current = this.db
      .query<HintRow, [string, string]>(hintCountsSql(true))
      .all(this.options.now(), ids);
    const counts = new Map<number, HintCounts>();
    for (const row of current) counts.set(row.memory_id, row);
    for (const row of rows) {
      const hints = counts.get(row.id);
      row.application_count = hints?.applications ?? 0;
      row.validated_helpful_count = hints?.validatedHelpful ?? 0;
      row.validated_harmful_count = hints?.validatedHarmful ?? 0;
    }
  }

  currentHintTotals(): HintCounts | undefined {
    if (!this.supportPropagationPending()) return undefined;
    const totals = this.db
      .query<HintCounts, [string]>(`SELECT
      coalesce(sum(applications),0) AS applications,
      coalesce(sum(validatedHelpful),0) AS validatedHelpful,
      coalesce(sum(validatedHarmful),0) AS validatedHarmful FROM (${hintCountsSql()})`)
      .get(this.options.now());
    if (!totals) throw new Error("Feedback hint aggregation returned no result.");
    return totals;
  }

  private supportPropagationPending(): boolean {
    return Boolean(this.db.query("SELECT 1 FROM lifecycle_invalidations LIMIT 1").get());
  }
  private commit(principal: MutationPrincipal, input: ParsedFeedback, hash: string): FeedbackResult {
    const context = assertCurrentPrincipal(this.options.lifecycle, principal);
    this.authorizeReference(principal, input.memoryRef);
    const supportValidUntil = this.authorizeEvidence(principal, input);
    const requestId = `feedback:${input.eventId}`;
    const prior = this.db
      .query<PriorFeedback, [string, string]>(
        "SELECT request_body_hash,result FROM memory_mutations WHERE principal_id=? AND request_id=?",
      )
      .get(principal.id, requestId);
    if (prior) {
      if (prior.request_body_hash !== hash)
        throw new MutationError(
          "request_conflict",
          "This feedback event already has a different canonical body.",
        );
      return { ...(JSON.parse(prior.result) as FeedbackResult), duplicate: true };
    }
    if (!this.disclosed(principal, input, context.nonce))
      throw new MutationError("scope_denied", "The canonical reference was not disclosed in this retrieval.");
    const validated = input.basis === "validator";
    this.db
      .query(`INSERT INTO memory_feedback
   (producer_id,event_id,retrieval_id,memory_id,revision,run_id,cycle_id,signal,basis,evidence_refs,created_at,validated,verifier_id,verifier_version,support_valid_until)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        principal.id,
        input.eventId,
        input.retrievalId,
        input.memoryRef.id,
        input.memoryRef.revision,
        input.runId,
        input.cycleId,
        input.signal,
        input.basis,
        JSON.stringify(input.evidenceRefs),
        this.options.now(),
        Number(validated),
        validated ? input.verifierId : null,
        validated ? input.verifierVersion : null,
        supportValidUntil,
      );
    const counter = feedbackCounter(input.signal, input.basis, validated);
    if (counter)
      this.db
        .query(
          `UPDATE memories SET ${counter}=${counter}+1 WHERE id=? AND record_revision=? AND deleted_at IS NULL AND state='active'`,
        )
        .run(input.memoryRef.id, input.memoryRef.revision);
    const result: FeedbackResult = {
      recorded: true,
      duplicate: false,
      validated,
      memoryRef: input.memoryRef,
    };
    this.db
      .query(`INSERT INTO memory_mutations
   (principal_id,request_id,request_body_hash,operation,memory_id,expected_revision,resulting_revision,result,created_at,actor_id)
   VALUES (?,?,?,'feedback',?,?,?,?,?,?)`)
      .run(
        principal.id,
        requestId,
        hash,
        input.memoryRef.id,
        input.memoryRef.revision,
        input.memoryRef.revision,
        JSON.stringify(result),
        this.options.now(),
        principal.actorId,
      );
    return result;
  }
  private authorizeReference(principal: MutationPrincipal, ref: MemoryRef): void {
    const tombstone = this.db
      .query("SELECT 1 FROM memory_tombstones WHERE kind='memory' AND identifier=?")
      .get(String(ref.id));
    if (tombstone && principal.access.kind === "owner")
      throw new MutationError(
        "context_invalidated",
        "This memory was forgotten; feedback cannot be replayed.",
      );
    const row = this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE id=?").get(ref.id);
    const namespace = row ? namespaceOf(row) : null;
    if (tombstone || !row || !namespace || !principal.access.allows("read", namespace)) this.unavailable();
    const revision = this.db
      .query<{ scope: string | null; project_key: string | null; bot_id: string | null }, [number, number]>(
        "SELECT json_extract(snapshot,'$.scope') AS scope,json_extract(snapshot,'$.project_key') AS project_key,json_extract(snapshot,'$.bot_id') AS bot_id FROM memory_revisions WHERE memory_id=? AND revision=?",
      )
      .get(ref.id, ref.revision);
    if (!revision) this.unavailable();
    // Unknown historical namespace stays owner-only; known namespaces use the canonical read check.
    const historical = namespaceOf(revision);
    if (historical ? !principal.access.allows("read", historical) : principal.access.kind !== "owner")
      this.unavailable();
  }
  private authorizeEvidence(principal: MutationPrincipal, input: ParsedFeedback): string | null {
    if (input.basis !== "agent_report" && principal.access.kind !== "owner")
      throw new MutationError("scope_denied", "An agent report cannot claim human or validator authority.");
    const evidence = this.options.provenance.getVisible(principal.access, input.evidenceRefs);
    if (evidence.length !== input.evidenceRefs.length) this.unavailable();
    if (evidence.some((item) => item.status !== "resolved"))
      throw new MutationError("invalid_input", "Feedback evidence must resolve under the current grant.");
    return input.basis === "validator" ? this.validationDeadline(evidence) : null;
  }

  private validationDeadline(evidence: readonly Evidence[]): string | null {
    let validUntil: string | null = null;
    for (const item of evidence) {
      const support = this.options.provenance.currentSupport(item);
      if (!support)
        throw new MutationError(
          "invalid_input",
          "Validator evidence must support the current source lifecycle and revision.",
        );
      if (support.validUntil !== null && (validUntil === null || support.validUntil < validUntil))
        validUntil = support.validUntil;
    }
    return validUntil;
  }
  private disclosed(principal: MutationPrincipal, input: ParsedFeedback, nonce: string | null): boolean {
    const rows = this.db
      .query<
        { nonce: string; agent_id: string | null },
        [string, number, number]
      >(`SELECT e.nonce,l.agent_id FROM audit_events e
   LEFT JOIN agent_links l ON l.nonce=e.nonce,
   json_each(CASE WHEN json_valid(e.detail) THEN e.detail ELSE '{}' END,'$.retrieval.memoryRefs') r
   WHERE json_extract(CASE WHEN json_valid(e.detail) THEN e.detail ELSE '{}' END,'$.retrieval.retrievalId')=?
   AND json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.id')=?
   AND json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.revision')=?`)
      .all(input.retrievalId, input.memoryRef.id, input.memoryRef.revision);
    return rows.some(
      (row) =>
        principal.access.kind === "owner" ||
        row.nonce === nonce ||
        Boolean(principal.agentId && row.agent_id === principal.agentId),
    );
  }
  private unavailable(): never {
    throw new MutationError("scope_denied", "Feedback reference or evidence is unavailable.");
  }
}

function feedbackCounter(signal: string, basis: string, validated: boolean): FeedbackCounter | null {
  if (signal === "applied" && (validated || basis === "human")) return "application_count";
  if (!validated) return null;
  if (signal === "helpful") return "validated_helpful_count";
  if (signal === "harmful") return "validated_harmful_count";
  return null;
}

interface StoredFeedback {
  producer_id: string;
  event_id: string;
  memory_id: number;
  revision: number;
  signal: string;
  basis: string;
  validated: number;
}
export function retractFeedbackEvidence(
  db: Database,
  evidenceIds: string[],
  mode: "invalidate" | "forget",
): void {
  for (const evidenceId of evidenceIds) {
    const rows = db
      .query<StoredFeedback, [string]>(`SELECT f.* FROM memory_feedback f
   WHERE EXISTS(SELECT 1 FROM json_each(f.evidence_refs) e WHERE e.value=?)`)
      .all(evidenceId);
    for (const row of rows) retractAssessment(db, row, mode);
  }
}

function retractAssessment(db: Database, row: StoredFeedback, mode: "invalidate" | "forget"): void {
  if (mode === "invalidate" && !row.validated) return;
  const counter = feedbackCounter(row.signal, row.basis, Boolean(row.validated));
  if (counter)
    db.query(`UPDATE memories SET ${counter}=max(0,${counter}-1) WHERE id=? AND record_revision=?`).run(
      row.memory_id,
      row.revision,
    );
  if (mode === "forget")
    db.query("DELETE FROM memory_feedback WHERE producer_id=? AND event_id=?").run(
      row.producer_id,
      row.event_id,
    );
  else
    db.query("UPDATE memory_feedback SET validated=0 WHERE producer_id=? AND event_id=?").run(
      row.producer_id,
      row.event_id,
    );
}

function hintCountsSql(selected = false): string {
  const selection = selected ? "AND f.memory_id IN (SELECT value FROM json_each(?))" : "";
  return `SELECT f.memory_id,
    sum(f.signal='applied') AS applications,
    sum(f.signal='helpful') AS validatedHelpful,
    sum(f.signal='harmful') AS validatedHarmful
    FROM memory_feedback f JOIN memories m ON m.id=f.memory_id AND m.record_revision=f.revision
    CROSS JOIN (SELECT ? AS at) hint_clock
    WHERE m.deleted_at IS NULL AND m.state='active' ${selection}
    AND ((f.basis='human' AND f.signal='applied') OR (f.validated=1
      AND json_array_length(CASE WHEN json_valid(f.evidence_refs) THEN f.evidence_refs ELSE '[]' END)>0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(f.evidence_refs) THEN f.evidence_refs ELSE '[]' END) j
        LEFT JOIN memory_evidence e ON e.evidence_id=j.value
        WHERE e.status IS NOT 'resolved' OR e.source_kind NOT IN ('memory','artifact')
          OR (e.source_kind='memory' AND NOT EXISTS (
            SELECT 1 FROM memories proof
            WHERE proof.id=CAST(substr(e.source_ref,8,instr(e.source_ref,'@')-8) AS INTEGER)
              AND e.source_ref=('memory:' || proof.id || '@' || proof.record_revision)
              AND proof.deleted_at IS NULL AND ${currentLifecycleSql("proof", "hint_clock.at", "ancestry")}
          ))
      )))
    GROUP BY f.memory_id`;
}
