import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Evidence,
  type MutationRequest,
  MutationRequestSchema,
  type MutationResult,
  MutationResultSchema,
  type ParsedMutation,
  RecordStateSchema,
} from "../shared/lifecycle";
import { type MemoryNamespace, namespaceColumns, namespaceOf, sameNamespace } from "../shared/namespaces";
import type { Access, Operation } from "./access";
import { eraseBridgeCopies } from "./bridge-privacy";
import { retractFeedbackEvidence } from "./feedback";
import type { Lifecycle } from "./lifecycle";
import type { Provenance } from "./provenance";
import { redact } from "./redact";
import type { Reservation, ReviewLedger } from "./review-ledger";
import type { MemoryRow } from "./store";
import { sha256 } from "./text";
import { dropVectors, purgeVectors } from "./vectors";

export interface MutationPrincipal {
  id: string;
  actorId: string;
  access: Access;
  agentId?: string | null;
  provider?: string | null;
  defaultNamespace?: MemoryNamespace;
  assertCurrent?: () => void;
  allowedMutations?: readonly ParsedMutation["operation"][];
}
interface MutationOptions {
  provenance: Provenance;
  lifecycle: Lifecycle;
  reviews: ReviewLedger;
  now: () => string;
  cancelReviews: (agentIds: string[]) => void;
  changed: (operation: MutationRequest["operation"]) => void;
}
interface CompatibilityRequest {
  operation: ParsedMutation["operation"];
  id: number;
  expectedRevision: number | null;
}
interface PriorMutation {
  request_body_hash: string;
  memory_id: number;
  operation: ParsedMutation["operation"];
  expected_revision: number | null;
  result: string;
}
interface ValidatedEvidence {
  records: Evidence[];
  ids: string[];
  outcome: MutationResult["evidenceValidation"];
}
type RecordChange = ParsedMutation["change"];
type AuthoritativeFields = Pick<
  MemoryRow,
  | "title"
  | "content"
  | "type"
  | "scope"
  | "project_key"
  | "bot_id"
  | "pinned"
  | "topic_key"
  | "content_hash"
  | "record_kind"
  | "state"
  | "verification_status"
  | "valid_from"
  | "valid_until"
  | "verified_at"
>;

export class MutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function assertCurrentPrincipal(lifecycle: Lifecycle, principal: MutationPrincipal) {
  principal.assertCurrent?.();
  const context = {
    principalId: principal.id,
    agentId: principal.agentId,
    nonce: principal.id.startsWith("nonce:")
      ? principal.id.slice(6)
      : /^(agent|credential):/.test(principal.id)
        ? principal.id
        : null,
  };
  if (lifecycle.contextInvalidated(context))
    throw new MutationError(
      "context_invalidated",
      "A source in this caller context was forgotten. Start a fresh authorized context.",
    );
  return context;
}

/** Object-key order is irrelevant to request identity. */
export function canonicalBody(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBody).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalBody(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class MemoryMutations {
  constructor(
    private readonly db: Database,
    private readonly options: MutationOptions,
  ) {}

  compatibilityRequest(principal: MutationPrincipal, requestId: string): CompatibilityRequest | null {
    const prior = this.prior(principal, requestId);
    if (!prior) return null;
    this.authorizeReplay(principal, prior);
    return { operation: prior.operation, id: prior.memory_id, expectedRevision: prior.expected_revision };
  }

  replay(principal: MutationPrincipal, input: MutationRequest): MutationResult | null {
    const request = MutationRequestSchema.parse(input);
    return this.previous(principal, request);
  }

  mutate(principal: MutationPrincipal, input: MutationRequest, reservation?: Reservation): MutationResult {
    const request = MutationRequestSchema.parse(input);
    try {
      const result = this.db.transaction(() => this.commit(principal, request, reservation))();
      this.options.changed(request.operation);
      return result;
    } catch (error) {
      if (reservation) this.options.reviews.release(reservation);
      throw error;
    }
  }

  private commit(
    principal: MutationPrincipal,
    request: ParsedMutation,
    reservation?: Reservation,
  ): MutationResult {
    const prior = this.previous(principal, request);
    if (prior) return prior;
    const current = request.id === undefined ? null : this.row(request.id);
    this.authorize(principal, request, current);
    this.assertRevision(principal.access, request, current);
    this.assertChangeFields(request);
    if (reservation) this.options.reviews.assertActive(reservation);
    this.meta("mutation_actor", principal.actorId);
    this.meta("mutation_reason", redact(request.reason));
    const evidence = this.validateEvidence(principal, request);
    const result = this.apply(principal, request, current, evidence.outcome);
    this.linkEvidence(principal, { request, current, result, evidence });
    if (reservation)
      this.options.reviews.settle(reservation, {
        consumed: ["created", "updated", "forgotten"].includes(result.status),
        memoryId: result.memoryRef.id,
        receipt: JSON.stringify(result),
      });
    this.db
      .query(`INSERT INTO memory_mutations
      (principal_id,request_id,request_body_hash,operation,memory_id,expected_revision,resulting_revision,result,created_at,actor_id,reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        principal.id,
        request.requestId,
        sha256(canonicalBody(request)),
        request.operation,
        result.memoryRef.id,
        request.expectedRevision ?? null,
        result.memoryRef.revision,
        JSON.stringify(result),
        this.options.now(),
        principal.actorId,
        redact(request.reason),
      );
    this.db.query("DELETE FROM meta WHERE key IN ('mutation_actor','mutation_reason')").run();
    return result;
  }

  private assertChangeFields(request: ParsedMutation): void {
    const common = [
      "title",
      "content",
      "type",
      "scope",
      "project",
      "botId",
      "topicKey",
      "pinned",
      "recordKind",
      "validFrom",
      "validUntil",
    ];
    const allowed: Record<ParsedMutation["operation"], string[]> = {
      create: [...common, "state"],
      propose: [...common, "state"],
      update: common,
      archive: [],
      reject: [],
      promote: [],
      forget: [],
      restore: ["sourceRevision"],
      merge: ["target"],
      supersede: ["target"],
      undo_merge: ["mergeId", "target"],
    };
    const invalid = Object.entries(request.change)
      .filter(([key, value]) => value !== undefined && !allowed[request.operation].includes(key))
      .map(([key]) => key);
    if (invalid.length > 0)
      throw new MutationError(
        "invalid_input",
        "The change contains fields not supported by this operation.",
        { fields: invalid },
      );
  }

  private prior(principal: MutationPrincipal, requestId: string): PriorMutation | null {
    assertCurrentPrincipal(this.options.lifecycle, principal);
    return this.db
      .query<PriorMutation, [string, string]>(
        "SELECT request_body_hash,memory_id,operation,expected_revision,result FROM memory_mutations WHERE principal_id=? AND request_id=?",
      )
      .get(principal.id, requestId);
  }

  private previous(principal: MutationPrincipal, request: ParsedMutation): MutationResult | null {
    assertOperationAllowed(principal, request.operation);
    const prior = this.prior(principal, request.requestId);
    if (!prior) return null;
    this.authorizeReplay(principal, prior);
    if (prior.request_body_hash !== sha256(canonicalBody(request)))
      throw new MutationError(
        "request_conflict",
        "This request ID was already used with a different canonical body.",
      );
    return MutationResultSchema.parse(JSON.parse(prior.result));
  }

  private authorizeReplay(principal: MutationPrincipal, prior: PriorMutation): void {
    if (this.tombstoned(prior.memory_id) && prior.operation !== "forget")
      throw new MutationError(
        "context_invalidated",
        "This memory was forgotten; its old result cannot be replayed.",
      );
    const row = this.row(prior.memory_id);
    if (row && !rowAllows(principal.access, row, "write"))
      throw new MutationError("scope_denied", "The current namespace is outside the mutation grant.");
  }

  private row(id: number): MemoryRow | null {
    return this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE id=?").get(id);
  }

  private tombstoned(id: number): boolean {
    return Boolean(
      this.db.query("SELECT 1 FROM memory_tombstones WHERE kind='memory' AND identifier=?").get(String(id)),
    );
  }

  private authorize(principal: MutationPrincipal, request: ParsedMutation, current: MemoryRow | null): void {
    const creating = request.operation === "create" || request.operation === "propose";
    if (!creating) this.authorizeExisting(principal, request, current);
    const ownerOnly =
      ["promote", "reject", "forget"].includes(request.operation) ||
      request.change.state === "active" ||
      request.change.recordKind === "preference";
    if (principal.access.kind !== "owner" && ownerOnly)
      throw new MutationError("scope_denied", "This operation requires owner authority.");
    if (!creating && current && hasNamespaceFields(request.change))
      this.authorizeDestination(principal.access, request.change, rowNamespace(current));
  }

  private authorizeExisting(
    principal: MutationPrincipal,
    request: ParsedMutation,
    current: MemoryRow | null,
  ): void {
    if (!current || this.tombstoned(current.id))
      throw new MutationError("scope_denied", "Memory is unavailable.");
    const operations: Partial<Record<ParsedMutation["operation"], Operation>> = {
      archive: "delete",
      forget: "delete",
      merge: "merge",
      undo_merge: "merge",
      restore: "restore",
    };
    if (!rowAllows(principal.access, current, operations[request.operation] ?? "write"))
      throw new MutationError("scope_denied", "Memory is unavailable.");
    if (request.operation !== "forget" && !namespaceOf(current))
      throw new MutationError(
        "invalid_state",
        "Memory namespace is unknown; forget it or repair it before changing it.",
      );
    if (principal.access.kind !== "owner" && current.record_kind === "preference")
      throw new MutationError(
        "scope_denied",
        "Changing a preference requires owner authority; submit a proposal instead.",
      );
  }

  private authorizeDestination(access: Access, change: RecordChange, base: MemoryNamespace): void {
    assertProjectGrant(access, change);
    if (!access.allows("write", destinationNamespace(change, base)))
      throw new MutationError("scope_denied", "The destination namespace is outside the mutation grant.");
  }

  private assertRevision(access: Access, request: ParsedMutation, current: MemoryRow | null): void {
    if (request.operation === "create" || request.operation === "propose") return;
    if (request.expectedRevision === undefined)
      throw new MutationError(
        "revision_conflict",
        "An expectedRevision is required for an existing memory.",
        { currentRevision: current?.record_revision },
      );
    if (request.expectedRevision !== current?.record_revision)
      throw new MutationError(
        "revision_conflict",
        "The memory changed; read its current revision before correcting it.",
        {
          currentRevision: current?.record_revision,
          diff: current ? this.diff(access, current, request.expectedRevision) : [],
        },
      );
  }

  private diff(access: Access, current: MemoryRow, expectedRevision: number): unknown[] {
    if (!access.allows("read", namespaceOf(current))) return [];
    const expected = this.db
      .query<{ snapshot: string }, [number, number]>(
        "SELECT snapshot FROM memory_revisions WHERE memory_id=? AND revision=?",
      )
      .get(current.id, expectedRevision);
    const old = expected ? z.record(z.string(), z.unknown()).parse(JSON.parse(expected.snapshot)) : null;
    if (!old || !historicalAllowed(access, old)) return [];
    return Object.entries(current)
      .filter(
        ([key, value]) =>
          old[key] !== value && !["shown_count", "opened_count", "use_count", "last_used_at"].includes(key),
      )
      .slice(0, 12)
      .map(([field, value]) => ({ field, previous: bounded(old[field]), current: bounded(value) }));
  }

  private validateEvidence(principal: MutationPrincipal, request: ParsedMutation): ValidatedEvidence {
    const existing = this.options.provenance.getVisible(principal.access, request.evidenceRefs);
    if (existing.length !== new Set(request.evidenceRefs).size)
      throw new MutationError("scope_denied", "Evidence is missing or outside the current grant.");
    for (const source of request.evidence) {
      if (this.options.provenance.sourceTombstoned(source.sourceRef))
        throw new MutationError("context_invalidated", "A forgotten source cannot be ingested again.");
    }
    const inline = request.evidence.map((source) => {
      const evidence = this.options.provenance.resolve(principal.access, principal.actorId, source);
      this.db
        .query("UPDATE memory_evidence SET agent_id=? WHERE evidence_id=?")
        .run(principal.agentId ?? null, evidence.evidenceId);
      return evidence;
    });
    const records = [...existing, ...inline];
    const outcome =
      records.length === 0
        ? "none"
        : records.every((e) => this.options.provenance.isCurrent(e))
          ? "resolved"
          : "unresolved";
    return { records, ids: [...new Set(records.map((e) => e.evidenceId))], outcome };
  }

  private linkEvidence(
    principal: MutationPrincipal,
    input: {
      request: ParsedMutation;
      current: MemoryRow | null;
      result: MutationResult;
      evidence: ValidatedEvidence;
    },
  ): void {
    const { request, current, result, evidence } = input;
    if (result.status === "forgotten" || result.status === "duplicate") return;
    const inherited = this.inheritedEvidence(request, current, evidence.ids);
    const visibleInherited = this.options.provenance
      .getVisible(principal.access, inherited)
      .map((e) => e.evidenceId);
    result.evidenceRefs = [...new Set([...visibleInherited, ...evidence.ids])];
    for (const evidenceId of result.evidenceRefs) {
      this.db
        .query("INSERT OR IGNORE INTO memory_evidence_links VALUES (?, ?, ?, 'supports')")
        .run(result.memoryRef.id, result.memoryRef.revision, evidenceId);
      this.linkDependency(principal, result.memoryRef, evidenceId);
    }
  }

  private inheritedEvidence(
    request: ParsedMutation,
    current: MemoryRow | null,
    supplied: string[],
  ): string[] {
    if (!current || supplied.length > 0 || request.operation === "promote") return [];
    if (request.operation === "restore") {
      return request.change.sourceRevision === undefined
        ? []
        : this.evidenceIds(current.id, request.change.sourceRevision);
    }
    return claimChanged(current, request.change) ? [] : this.evidenceIds(current.id, current.record_revision);
  }

  private linkDependency(
    principal: MutationPrincipal,
    ref: MutationResult["memoryRef"],
    evidenceId: string,
  ): void {
    const source = this.db
      .query<{ source_kind: string; source_ref: string; status: string }, [string]>(
        "SELECT source_kind,source_ref,status FROM memory_evidence WHERE evidence_id=?",
      )
      .get(evidenceId);
    const match = source?.source_kind === "memory" ? /^memory:(\d+)@(\d+)$/.exec(source.source_ref) : null;
    if (!match || source?.status !== "resolved") return;
    this.db
      .query("INSERT OR IGNORE INTO memory_relations VALUES (?, ?, ?, ?, 'derived_from', ?, ?, 'verified')")
      .run(Number(match[1]), Number(match[2]), ref.id, ref.revision, principal.actorId, this.options.now());
  }

  private apply(
    principal: MutationPrincipal,
    request: ParsedMutation,
    current: MemoryRow | null,
    validation: MutationResult["evidenceValidation"],
  ): MutationResult {
    if (request.operation === "create" || request.operation === "propose")
      return this.create(principal, request, validation);
    if (!current) throw new MutationError("scope_denied", "Memory is unavailable.");
    if (request.operation === "forget") return this.forget(principal, current);
    if (request.operation === "undo_merge") return this.undoMerge(principal, request, current, validation);
    if (request.operation === "merge" || request.operation === "supersede")
      return this.replace(principal, request, current, validation);
    const change =
      request.operation === "restore"
        ? this.restoredChange(principal.access, request, current)
        : request.change;
    const fields = this.updatedFields(principal, { request, current, change, validation });
    if (sameFields(current, fields) && request.evidence.length === 0 && request.evidenceRefs.length === 0)
      return this.result(current, "unchanged", validation);
    this.project(change.project);
    this.writeUpdate(current, fields);
    return this.result(this.row(current.id) as MemoryRow, "updated", validation);
  }

  private writeUpdate(current: MemoryRow, fields: AuthoritativeFields): void {
    const columns = Object.keys(fields);
    const archivedAt = fields.state === "archived" ? this.options.now() : null;
    this.db
      .query(`UPDATE memories SET ${columns.map((key) => `${key}=?`).join(",")}, deleted_at=?,archived_at=?,merged_into=NULL,
      record_revision=record_revision+1,revision_count=revision_count+1,index_generation=index_generation+1,updated_at=? WHERE id=?`)
      .run(...Object.values(fields), archivedAt, archivedAt, this.options.now(), current.id);
    this.invalidate(current);
  }

  private restoredChange(access: Access, request: ParsedMutation, current: MemoryRow): RecordChange {
    if (request.change.sourceRevision === undefined)
      throw new MutationError("invalid_input", "Restore requires change.sourceRevision.");
    const revision = this.db
      .query<{ snapshot: string }, [number, number]>(
        "SELECT snapshot FROM memory_revisions WHERE memory_id=? AND revision=?",
      )
      .get(current.id, request.change.sourceRevision);
    if (!revision) throw new MutationError("invalid_input", "The requested revision is unavailable.");
    const old = JSON.parse(revision.snapshot) as Partial<MemoryRow>;
    if (!historicalAllowed(access, old))
      throw new MutationError("scope_denied", "The historical namespace is outside the restore grant.");
    return {
      title: old.title,
      content: old.content,
      type: old.type ?? current.type,
      pinned: Boolean(old.pinned),
      recordKind: old.record_kind ?? current.record_kind,
      validFrom: old.valid_from ?? null,
      validUntil: old.valid_until ?? null,
    };
  }

  private updatedFields(
    principal: MutationPrincipal,
    input: {
      request: ParsedMutation;
      current: MemoryRow;
      change: RecordChange;
      validation: MutationResult["evidenceValidation"];
    },
  ): AuthoritativeFields {
    const { request, current, change, validation } = input;
    const title = redact(change.title ?? current.title).trim();
    const content = redact(change.content ?? current.content).trim();
    const type = change.type ?? current.type;
    const validFrom = change.validFrom === undefined ? current.valid_from : change.validFrom;
    const validUntil = change.validUntil === undefined ? current.valid_until : change.validUntil;
    this.validity(validFrom, validUntil);
    const verification = this.verificationFor(current, { change, request, validation });
    return {
      title,
      content,
      type,
      ...namespaceColumns(destinationNamespace(change, rowNamespace(current))),
      ...curationFields(current, change),
      content_hash: sha256(`${type}\n${title}\n${content}`),
      record_kind: change.recordKind ?? current.record_kind,
      state: this.nextState(principal, input),
      valid_from: validFrom,
      valid_until: validUntil,
      ...verification,
    };
  }

  private nextState(
    principal: MutationPrincipal,
    input: {
      request: ParsedMutation;
      current: MemoryRow;
      change: RecordChange;
      validation: MutationResult["evidenceValidation"];
    },
  ): MemoryRow["state"] {
    const { request, current, change, validation } = input;
    if (request.operation === "promote") {
      this.assertPromotable(current, validation);
      return "active";
    }
    const states: Partial<Record<ParsedMutation["operation"], MemoryRow["state"]>> = {
      archive: "archived",
      reject: "rejected",
      restore: "candidate",
    };
    if (states[request.operation]) return states[request.operation] as MemoryRow["state"];
    if (this.requiresCandidate(principal.access, input)) return "candidate";
    if (change.state === "active" && current.state !== "active")
      throw new MutationError("invalid_state", "Use promote to validate a non-active record.");
    return change.state ?? current.state;
  }

  private requiresCandidate(
    access: Access,
    input: { current: MemoryRow; change: RecordChange; validation: MutationResult["evidenceValidation"] },
  ): boolean {
    if (input.validation === "unresolved") return true;
    if (!claimChanged(input.current, input.change)) return false;
    return access.kind !== "owner" || input.current.record_kind === "derived_summary";
  }

  private assertPromotable(current: MemoryRow, validation: MutationResult["evidenceValidation"]): void {
    if (!["candidate", "needs_recheck", "archived"].includes(current.state))
      throw new MutationError(
        "invalid_state",
        "Only candidates, archived or needs-recheck records can be promoted.",
      );
    if (current.record_kind === "derived_summary" && validation !== "resolved")
      throw new MutationError("invalid_input", "A derived summary needs resolved evidence to be promoted.");
  }

  private verificationFor(
    current: MemoryRow,
    input: {
      change: RecordChange;
      request: ParsedMutation;
      validation: MutationResult["evidenceValidation"];
    },
  ): Pick<MemoryRow, "verification_status" | "verified_at"> {
    if (input.validation === "resolved" || input.request.operation === "promote")
      return { verification_status: "verified", verified_at: this.options.now() };
    if (input.validation === "unresolved" || claimChanged(current, input.change))
      return { verification_status: "unverified", verified_at: null };
    return { verification_status: current.verification_status, verified_at: current.verified_at };
  }

  private create(
    principal: MutationPrincipal,
    request: ParsedMutation,
    validation: MutationResult["evidenceValidation"],
  ): MutationResult {
    const change = request.change;
    if (!change.title || !change.content)
      throw new MutationError("invalid_input", "Create requires title and content.");
    const namespace = this.creationNamespace(principal, change);
    const fields = this.createdFields(principal, request, validation, namespace);
    this.project(change.project);
    const location = namespaceColumns(namespace);
    const duplicate = this.db
      .query<MemoryRow, [string, string, string, string]>(
        "SELECT * FROM memories WHERE content_hash=? AND scope=? AND ifnull(project_key,'')=? AND ifnull(bot_id,'')=? AND deleted_at IS NULL",
      )
      .get(fields.content_hash, location.scope, location.project_key ?? "", location.bot_id ?? "");
    if (duplicate && this.compatibleDuplicate(duplicate, fields))
      return this.result(duplicate, "duplicate", validation);
    const maxId =
      this.db
        .query<{ n: number }, []>(`SELECT max(n) AS n FROM (
      SELECT ifnull(max(id),0) AS n FROM memories UNION ALL SELECT ifnull(max(CAST(identifier AS INTEGER)),0) FROM memory_tombstones WHERE kind='memory')`)
        .get()?.n ?? 0;
    const columns = Object.keys(fields);
    const write = this.db
      .query(`INSERT INTO memories(id,${columns.join(",")},source,agent_id,provider,created_at,updated_at)
      VALUES (?,${columns.map(() => "?").join(",")},?,?,?,?,?)`)
      .run(
        maxId + 1,
        ...Object.values(fields),
        principal.access.kind === "owner" ? "user" : "agent",
        principal.agentId ?? null,
        principal.provider ?? null,
        this.options.now(),
        this.options.now(),
      );
    return this.result(this.row(Number(write.lastInsertRowid)) as MemoryRow, "created", validation);
  }

  private creationNamespace(principal: MutationPrincipal, change: RecordChange): MemoryNamespace {
    assertProjectGrant(principal.access, change);
    const namespace = destinationNamespace(change, principal.defaultNamespace ?? { kind: "global" });
    if (!principal.access.allows("write", namespace))
      throw new MutationError("scope_denied", "The namespace is outside the mutation grant.");
    return namespace;
  }

  private createdFields(
    principal: MutationPrincipal,
    request: ParsedMutation,
    validation: MutationResult["evidenceValidation"],
    namespace: MemoryNamespace,
  ): AuthoritativeFields {
    const change = request.change;
    const title = redact(change.title ?? "").trim();
    const content = redact(change.content ?? "").trim();
    const type = change.type ?? "note";
    const kind = this.creationKind(principal.access, change, type);
    const disposition = this.creationDisposition(principal.access, { request, validation, kind });
    this.validity(change.validFrom ?? null, change.validUntil ?? null);
    return {
      title,
      content,
      type,
      ...namespaceColumns(namespace),
      ...creationCuration(change),
      content_hash: sha256(`${type}\n${title}\n${content}`),
      record_kind: kind,
      state: disposition,
      // Resolved source provenance does not verify a proposed claim.
      ...verifiedFields(request.operation === "propose" ? "none" : validation, this.options.now()),
      valid_from: change.validFrom ?? null,
      valid_until: change.validUntil ?? null,
    };
  }

  private creationKind(access: Access, change: RecordChange, type: string): MemoryRow["record_kind"] {
    const kind =
      change.recordKind ?? (type === "preference" && access.kind === "owner" ? "preference" : "fact");
    if (kind === "procedure_ref" && !change.content?.startsWith("playbook:"))
      throw new MutationError(
        "invalid_input",
        "A procedure reference must identify a Bots-owned approved playbook version.",
      );
    return kind;
  }

  private creationDisposition(
    access: Access,
    input: {
      request: ParsedMutation;
      validation: MutationResult["evidenceValidation"];
      kind: MemoryRow["record_kind"];
    },
  ): MemoryRow["state"] {
    const { request, validation, kind } = input;
    if (request.operation === "propose" || access.kind !== "owner" || validation === "unresolved")
      return "candidate";
    if (kind === "lesson" || (kind === "derived_summary" && validation !== "resolved")) return "candidate";
    return request.change.state ?? "active";
  }

  private compatibleDuplicate(current: MemoryRow, next: AuthoritativeFields): boolean {
    return (
      current.record_kind === next.record_kind &&
      current.valid_from === next.valid_from &&
      current.valid_until === next.valid_until
    );
  }

  private replace(
    principal: MutationPrincipal,
    request: ParsedMutation,
    current: MemoryRow,
    validation: MutationResult["evidenceValidation"],
  ): MutationResult {
    this.assertReplaceable(current);
    const target = request.change.target;
    if (!target || target.id === current.id)
      throw new MutationError("invalid_input", "A distinct target memory reference is required.");
    const replacement = this.row(target.id);
    if (replacement?.state !== "active" || !rowAllows(principal.access, replacement, "write"))
      throw new MutationError("scope_denied", "Replacement memory is unavailable.");
    if (replacement.record_revision !== target.revision)
      throw new MutationError("revision_conflict", "The replacement changed.", {
        currentRevision: replacement.record_revision,
      });
    if (!sameNamespace(rowNamespace(replacement), rowNamespace(current)))
      throw new MutationError("scope_denied", "Merge and supersession cannot cross namespaces.");
    this.db
      .query("INSERT OR IGNORE INTO memory_relations VALUES (?, ?, ?, ?, ?, ?, ?, 'verified')")
      .run(
        current.id,
        current.record_revision,
        target.id,
        target.revision,
        request.operation === "merge" ? "duplicate_of" : "superseded_by",
        principal.actorId,
        this.options.now(),
      );
    if (request.operation === "merge")
      this.db
        .query(
          "INSERT INTO memory_merges(source_id,target_id,relation,actor,source_snapshot,target_snapshot,created_at) VALUES (?,?,'duplicate_of',?,?,?,?)",
        )
        .run(
          current.id,
          target.id,
          principal.actorId,
          JSON.stringify(current),
          JSON.stringify(replacement),
          this.options.now(),
        );
    this.db
      .query(`UPDATE memories SET state='superseded',deleted_at=?,merged_into=?,record_revision=record_revision+1,
      index_generation=index_generation+1,updated_at=? WHERE id=?`)
      .run(this.options.now(), target.id, this.options.now(), current.id);
    this.invalidate(current);
    return this.result(this.row(current.id) as MemoryRow, "updated", validation);
  }

  private assertReplaceable(current: MemoryRow): void {
    if (current.deleted_at || current.state === "archived" || current.state === "superseded")
      throw new MutationError(
        "invalid_input",
        "An already removed memory cannot be merged or superseded again.",
      );
  }

  private undoMerge(
    principal: MutationPrincipal,
    request: ParsedMutation,
    current: MemoryRow,
    validation: MutationResult["evidenceValidation"],
  ): MutationResult {
    const target = request.change.target;
    if (!target || !request.change.mergeId)
      throw new MutationError("invalid_input", "Undo requires mergeId and the current target reference.");
    const destination = this.row(target.id);
    if (!destination || !rowAllows(principal.access, destination, "merge"))
      throw new MutationError("scope_denied", "Merge target is unavailable.");
    if (destination.record_revision !== target.revision)
      throw new MutationError("revision_conflict", "The merge target changed.", {
        currentRevision: destination.record_revision,
      });
    const previousState = this.assertUndoRelation(current, request.change.mergeId, target.id);
    const ids = this.evidenceIds(current.id, current.record_revision);
    const evidence = this.options.provenance.getVisible(principal.access, ids);
    const resolved =
      validation !== "unresolved" &&
      evidence.length === ids.length &&
      evidence.every((entry) => this.options.provenance.isCurrent(entry));
    const state = previousState === "active" && !resolved ? "needs_recheck" : previousState;
    this.db
      .query(`UPDATE memories SET state=?,deleted_at=NULL,archived_at=NULL,merged_into=NULL,
      record_revision=record_revision+1,revision_count=revision_count+1,index_generation=index_generation+1,updated_at=? WHERE id=?`)
      .run(state, this.options.now(), current.id);
    this.db
      .query("UPDATE memory_merges SET undone_at=? WHERE id=?")
      .run(this.options.now(), request.change.mergeId);
    this.invalidate(current);
    return this.result(
      this.row(current.id) as MemoryRow,
      "updated",
      evidenceOutcome(ids.length, resolved, validation),
    );
  }

  private assertUndoRelation(current: MemoryRow, mergeId: number, targetId: number): MemoryRow["state"] {
    const merge = this.db
      .query<
        { source_id: number; target_id: number; undone_at: string | null; source_state: string | null },
        [number]
      >(
        "SELECT source_id,target_id,undone_at,json_extract(source_snapshot,'$.state') AS source_state FROM memory_merges WHERE id=?",
      )
      .get(mergeId);
    if (
      !merge ||
      merge.source_id !== current.id ||
      merge.target_id !== targetId ||
      merge.undone_at !== null ||
      current.merged_into !== targetId
    ) {
      throw new MutationError("revision_conflict", "That merge is no longer current.");
    }
    const previousState = RecordStateSchema.parse(merge.source_state ?? "candidate");
    if (!current.topic_key) return previousState;
    const clash = this.db
      .query(
        "SELECT 1 FROM memories WHERE scope=? AND ifnull(project_key,'')=? AND ifnull(bot_id,'')=? AND topic_key=? AND deleted_at IS NULL AND id!=?",
      )
      .get(current.scope, current.project_key ?? "", current.bot_id ?? "", current.topic_key, current.id);
    if (clash) throw new MutationError("request_conflict", "Another memory now owns the restored topic key.");
    return previousState;
  }

  private forget(principal: MutationPrincipal, current: MemoryRow): MutationResult {
    const { preview, nonces } = this.options.lifecycle.erasurePlan(principal.access, current.id);
    const ids = preview.records.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const ts = this.options.now();
    for (const ref of preview.records)
      this.db
        .query("INSERT OR IGNORE INTO memory_tombstones VALUES ('memory',?,?,?)")
        .run(String(ref.id), ts, principal.id);
    for (const source of preview.sources)
      this.db
        .query("INSERT OR IGNORE INTO memory_tombstones VALUES ('source',?,?,?)")
        .run(source, ts, principal.id);
    this.eraseSessionCopies(principal, preview.affectedAgentIds);
    this.eraseCallerCopies(principal, nonces, ids);
    this.eraseEvidence(preview.evidenceIds, new Set(ids));
    eraseBridgeCopies(this.db, ts, (agents) => this.invalidateContexts(principal, agents));
    for (const source of preview.sources)
      this.db.query("DELETE FROM source_artifacts WHERE source_ref=?").run(source);
    for (const ref of preview.records) {
      this.options.lifecycle.invalidate(ref);
      purgeVectors(this.db, ref.id);
    }
    this.db
      .prepare(
        `DELETE FROM memory_merges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      )
      .run(...ids, ...ids);
    this.db
      .prepare(
        `DELETE FROM memory_relations WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
      )
      .run(...ids, ...ids);
    for (const table of ["memory_versions", "memory_revisions", "memory_evidence_links", "memory_feedback"])
      this.db.prepare(`DELETE FROM ${table} WHERE memory_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    this.db
      .prepare(`UPDATE memory_mutations SET reason=NULL WHERE memory_id IN (${placeholders})`)
      .run(...ids);
    this.db.prepare(`UPDATE review_ops SET receipt=NULL WHERE memory_id IN (${placeholders})`).run(...ids);
    return {
      status: "forgotten",
      memoryRef: { id: current.id, revision: current.record_revision },
      state: "archived",
      evidenceValidation: "none",
      evidenceRefs: [],
    };
  }

  invalidateContexts(principal: MutationPrincipal, agents: readonly string[]): void {
    if (principal.access.kind !== "owner")
      throw new MutationError("scope_denied", "Only the owner can erase controlled context copies.");
    const closure = this.options.lifecycle.contextClosure(agents);
    this.eraseSessionCopies(principal, closure.agents);
    this.eraseCallerCopies(principal, closure.nonces, []);
  }

  private eraseSessionCopies(principal: MutationPrincipal, agentIds: string[]): void {
    this.options.cancelReviews(agentIds);
    for (const agentId of agentIds) {
      this.db
        .query("INSERT OR IGNORE INTO memory_tombstones VALUES ('session',?,?,?)")
        .run(agentId, this.options.now(), principal.id);
      this.db.query("DELETE FROM sessions WHERE agent_id=?").run(agentId);
      this.db
        .query("DELETE FROM audit_events WHERE nonce IN (SELECT nonce FROM agent_links WHERE agent_id=?)")
        .run(agentId);
      this.db
        .query("UPDATE review_windows SET closed_at=? WHERE agent_id=? AND closed_at IS NULL")
        .run(this.options.now(), agentId);
    }
  }

  private eraseCallerCopies(principal: MutationPrincipal, nonces: string[], ids: number[]): void {
    const ts = this.options.now();
    for (const nonce of nonces) {
      this.db
        .query("INSERT OR IGNORE INTO memory_tombstones VALUES ('caller',?,?,?)")
        .run(nonce, ts, principal.id);
      this.db.query("DELETE FROM audit_events WHERE nonce=?").run(nonce);
      this.db
        .query("UPDATE review_windows SET closed_at=? WHERE nonce=? AND closed_at IS NULL")
        .run(ts, nonce);
    }
    if (ids.length === 0) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO memory_tombstones(kind,identifier,forgotten_at,principal_id)
      SELECT 'principal',principal_id,?,? FROM memory_mutations WHERE memory_id IN (${ids.map(() => "?").join(",")})
        AND (principal_id LIKE 'nonce:%' OR principal_id LIKE 'agent:%' OR principal_id LIKE 'credential:%' OR principal_id LIKE 'bridge:%')`)
      .run(ts, principal.id, ...ids);
  }

  private eraseEvidence(evidenceIds: string[], forgottenIds: Set<number>): void {
    retractFeedbackEvidence(this.db, evidenceIds, "forget");
    for (const evidenceId of evidenceIds) {
      const linked = this.db
        .query<{ memory_id: number; revision: number }, [string]>(
          "SELECT memory_id,revision FROM memory_evidence_links WHERE evidence_id=?",
        )
        .all(evidenceId);
      for (const link of linked) {
        if (forgottenIds.has(link.memory_id)) continue;
        this.db
          .query(
            "UPDATE memories SET state='needs_recheck',verification_status='unresolved',verified_at=NULL,record_revision=record_revision+1,index_generation=index_generation+1,updated_at=? WHERE id=?",
          )
          .run(this.options.now(), link.memory_id);
        this.invalidate({ id: link.memory_id, record_revision: link.revision });
      }
      this.db.query("DELETE FROM memory_evidence_links WHERE evidence_id=?").run(evidenceId);
      this.db.query("DELETE FROM memory_evidence WHERE evidence_id=?").run(evidenceId);
    }
  }

  private invalidate(current: Pick<MemoryRow, "id" | "record_revision">): void {
    this.options.lifecycle.invalidate({ id: current.id, revision: current.record_revision });
    dropVectors(this.db, current.id);
  }

  private result(
    row: MemoryRow,
    status: MutationResult["status"],
    evidenceValidation: MutationResult["evidenceValidation"],
  ): MutationResult {
    return {
      status,
      memoryRef: { id: row.id, revision: row.record_revision },
      state: row.state,
      evidenceValidation,
      evidenceRefs: this.evidenceIds(row.id, row.record_revision),
    };
  }

  private evidenceIds(id: number, revision: number): string[] {
    return this.db
      .query<{ evidence_id: string }, [number, number]>(
        "SELECT evidence_id FROM memory_evidence_links WHERE memory_id=? AND revision=?",
      )
      .all(id, revision)
      .map((e) => e.evidence_id);
  }

  private validity(from: string | null, until: string | null): void {
    if (from && until && Date.parse(from) >= Date.parse(until))
      throw new MutationError("invalid_input", "validUntil must be later than validFrom.");
  }

  private project(project: RecordChange["project"]): void {
    if (!project) return;
    this.db
      .query(
        "INSERT INTO projects(key,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",
      )
      .run(project.key, project.name, project.rootPath, this.options.now(), this.options.now());
    if (project.paseoProjectId)
      this.db
        .query(`INSERT INTO project_aliases(paseo_project_id,project_key,updated_at)
      VALUES (?,?,?) ON CONFLICT(paseo_project_id) DO UPDATE SET project_key=excluded.project_key,updated_at=excluded.updated_at`)
        .run(project.paseoProjectId, project.key, this.options.now());
  }

  private meta(key: string, value: string): void {
    this.db
      .query("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }
}

export function ownerMutation(access: Access): MutationPrincipal {
  return { id: "owner", actorId: "owner", access };
}
function assertOperationAllowed(principal: MutationPrincipal, operation: ParsedMutation["operation"]): void {
  if (principal.allowedMutations && !principal.allowedMutations.includes(operation))
    throw new MutationError("scope_denied", "This mutation is outside the caller grant.");
}
export function mutationRequestId(): string {
  return randomUUID();
}
function rowNamespace(row: MemoryRow): MemoryNamespace {
  const namespace = namespaceOf(row);
  if (!namespace)
    throw new MutationError(
      "invalid_state",
      "Memory namespace is unknown; forget it or repair it before changing it.",
    );
  return namespace;
}
function rowAllows(access: Access, row: MemoryRow, operation: Operation): boolean {
  if (access.kind === "owner") return true;
  const namespace = namespaceOf(row);
  return namespace !== null && access.allows(operation, namespace);
}
function bounded(value: unknown): unknown {
  return typeof value === "string" ? value.slice(0, 240) : (value ?? null);
}
function historicalAllowed(access: Access, old: Partial<MemoryRow> | Record<string, unknown>): boolean {
  if (access.kind === "owner") return true;
  const namespace = namespaceOf({ scope: old.scope, project_key: old.project_key, bot_id: old.bot_id });
  return namespace !== null && access.allows("read", namespace);
}
function hasNamespaceFields(change: RecordChange): boolean {
  return change.scope !== undefined || change.project !== undefined || change.botId !== undefined;
}
function contradictoryNamespace(): MutationError {
  return new MutationError("invalid_input", "The destination namespace fields contradict each other.");
}
function assertProjectGrant(access: Access, change: RecordChange): void {
  const key = change.project?.key;
  if (key && !access.allows("write", { kind: "project", projectKey: key }))
    throw new MutationError("scope_denied", "The supplied project is outside the mutation grant.");
}
// Kind comes only from explicit scope, else the trusted base; project metadata never picks a namespace alone.
function destinationNamespace(change: RecordChange, base: MemoryNamespace): MemoryNamespace {
  assertNamespaceFields(change, base);
  const kind = change.scope ?? base.kind;
  if (kind === "global") return { kind: "global" };
  if (kind === "project") return projectDestination(change, base);
  const botId = change.botId ?? (base.kind === "bot" ? base.botId : null);
  if (!botId) throw new MutationError("scope_denied", "Bot namespace is unresolved.");
  return { kind: "bot", botId };
}
function projectDestination(change: RecordChange, base: MemoryNamespace): MemoryNamespace {
  const projectKey = change.project?.key ?? (base.kind === "project" ? base.projectKey : null);
  if (!projectKey) throw new MutationError("scope_denied", "Project is unresolved.");
  return { kind: "project", projectKey };
}
function assertNamespaceFields(change: RecordChange, base: MemoryNamespace): void {
  const kind = change.scope ?? base.kind;
  if (change.botId != null && kind !== "bot") throw contradictoryNamespace();
  if (change.scope === undefined) {
    assertImplicitNamespace(change, base);
    return;
  }
  if (change.scope !== "project" && change.project != null) throw contradictoryNamespace();
}
function assertImplicitNamespace(change: RecordChange, base: MemoryNamespace): void {
  if (base.kind === "bot" && change.botId != null && change.botId !== base.botId)
    throw contradictoryNamespace();
  if (base.kind === "project" && change.project != null && change.project.key !== base.projectKey)
    throw contradictoryNamespace();
}
function sameFields(current: MemoryRow, next: AuthoritativeFields): boolean {
  return Object.entries(next).every(([key, value]) => current[key as keyof AuthoritativeFields] === value);
}

function curationFields(current: MemoryRow, change: RecordChange): Pick<MemoryRow, "pinned" | "topic_key"> {
  return {
    pinned: change.pinned === undefined ? current.pinned : Number(change.pinned),
    topic_key: change.topicKey === undefined ? current.topic_key : change.topicKey,
  };
}
function verifiedFields(
  validation: MutationResult["evidenceValidation"],
  now: string,
): Pick<MemoryRow, "verification_status" | "verified_at"> {
  return {
    verification_status: validation === "resolved" ? "verified" : "unverified",
    verified_at: validation === "resolved" ? now : null,
  };
}

function creationCuration(change: RecordChange): Pick<MemoryRow, "pinned" | "topic_key"> {
  return { pinned: Number(change.pinned ?? false), topic_key: change.topicKey ?? null };
}

const CLAIM_FIELDS = {
  title: "title",
  content: "content",
  type: "type",
  recordKind: "record_kind",
  validFrom: "valid_from",
  validUntil: "valid_until",
} as const satisfies Partial<Record<keyof RecordChange, keyof MemoryRow>>;
function claimChanged(current: MemoryRow, change: RecordChange): boolean {
  const namespace = namespaceOf(current);
  if (
    namespace &&
    hasNamespaceFields(change) &&
    !sameNamespace(destinationNamespace(change, namespace), namespace)
  )
    return true;
  return Object.entries(CLAIM_FIELDS).some(([key, column]) => {
    const value = change[key as keyof typeof CLAIM_FIELDS];
    if (value === undefined) return false;
    const canonical = key === "title" || key === "content" ? redact(String(value)).trim() : value;
    return canonical !== current[column];
  });
}

function evidenceOutcome(
  count: number,
  resolved: boolean,
  validation: MutationResult["evidenceValidation"],
): MutationResult["evidenceValidation"] {
  if (validation === "unresolved" || count === 0) return validation;
  return resolved ? "resolved" : "unresolved";
}
