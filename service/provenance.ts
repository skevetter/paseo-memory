import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Evidence, type EvidenceInput, EvidenceInputSchema } from "../shared/lifecycle";
import {
  type MemoryNamespace,
  namespaceColumns,
  namespaceOf,
  type Scope,
  sameNamespace,
} from "../shared/namespaces";
import type { Access } from "./access";
import { currentLifecycleSql, sourceRevisionsSql } from "./lifecycle";
import { MutationError } from "./mutations";
import { redact } from "./redact";
import { sha256 } from "./text";

const ARTIFACT_REF = /^artifact:[A-Za-z0-9_-][A-Za-z0-9._-]{0,990}$/;
const ARTIFACT_MAX_BYTES = 16 * 1024;
const EXCERPT_MAX_CHARS = 500;
const RevisionSnapshotSchema = z.object({
  title: z.string(),
  content: z.string(),
  scope: z.enum(["global", "project", "bot"]).optional(),
  project_key: z.string().nullable().optional(),
  bot_id: z.string().nullable().optional(),
  updated_at: z.string().optional(),
});

interface EvidenceSupport {
  readonly validUntil: string | null;
}
const UNBOUNDED_SUPPORT: EvidenceSupport = Object.freeze({ validUntil: null });

type MemorySource = { id: number; revision: number };
type Source = {
  namespace: MemoryNamespace | null;
  hash: string;
  content: string;
  allowExcerpt: boolean;
  sourceEventAt: string | null;
};
type EvidenceRow = {
  evidence_id: string;
  source_kind: string;
  source_ref: string;
  source_hash: string | null;
  observed_at: string | null;
  source_event_at: string | null;
  stored_at: string;
  status: "resolved" | "unresolved";
  reason: string | null;
  excerpt: string | null;
  scope: Scope;
  project_key: string | null;
  namespace_bot_id: string | null;
};
type ArtifactRow = {
  content: string;
  source_hash: string;
  scope: Scope;
  project_key: string | null;
  bot_id: string | null;
  allow_excerpt: number;
  source_event_at: string | null;
};

/** Sources are local, immutable records, never paths or URLs to fetch. */
export class Provenance {
  constructor(
    private readonly db: Database,
    private readonly now: () => string,
  ) {}

  resolve(access: Access, actorId: string, input: EvidenceInput): Evidence {
    const parsed = EvidenceInputSchema.parse(input);
    const storedAt = this.now();
    const tombstoned = this.sourceTombstoned(parsed.sourceRef);
    const source = tombstoned ? null : this.readSource(access, parsed.sourceKind, parsed.sourceRef);
    const evidence = unresolvedEvidence(
      parsed,
      storedAt,
      tombstoned ? "source_forgotten" : "source_unavailable",
    );
    if (source) resolveSource(evidence, source, parsed, storedAt);
    const stored = storedNamespace(source?.namespace ?? null);
    this.db
      .query(
        `INSERT INTO memory_evidence
          (evidence_id, source_kind, source_ref, source_hash, observed_at, source_event_at, stored_at,
           actor_id, agent_id, bot_id, run_id, cycle_id, excerpt, sensitivity, status, reason, scope, project_key,
           namespace_bot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'private', ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.evidenceId,
        evidence.sourceKind,
        evidence.sourceRef,
        evidence.sourceHash,
        evidence.observedAt,
        evidence.sourceEventAt,
        evidence.storedAt,
        actorId,
        evidence.excerpt,
        evidence.status,
        evidence.reason,
        stored.scope,
        stored.project_key,
        stored.namespace_bot_id,
      );
    return evidence;
  }

  getVisible(access: Access, evidenceIds: string[]): Evidence[] {
    const visible: Evidence[] = [];
    const query = this.db.query<EvidenceRow, [string]>(`SELECT * FROM memory_evidence WHERE evidence_id = ?`);
    for (const id of new Set(evidenceIds)) {
      const row = query.get(id);
      if (!row) continue;
      const evidence = this.visibleEvidence(access, row);
      if (evidence) visible.push(evidence);
    }
    return visible;
  }

  isCurrent(evidence: Evidence): boolean {
    return this.currentSupport(evidence) !== null;
  }

  currentSupport(evidence: Evidence): EvidenceSupport | null {
    if (evidence.status !== "resolved") return null;
    if (evidence.sourceKind !== "memory") return UNBOUNDED_SUPPORT;
    return this.memorySupport(evidence.sourceRef);
  }

  currentSource(
    access: Access,
    kind: EvidenceInput["sourceKind"],
    ref: string,
  ): (EvidenceSupport & { readonly sourceHash: string }) | null {
    if (this.sourceTombstoned(ref)) return null;
    if (kind === "artifact" && !ARTIFACT_REF.test(ref)) return null;
    const source = this.readSource(access, kind, ref);
    if (!source) return null;
    const support = kind === "memory" ? this.memorySupport(ref) : UNBOUNDED_SUPPORT;
    return support ? { ...support, sourceHash: source.hash } : null;
  }
  sourceReadable(access: Access, kind: EvidenceInput["sourceKind"], ref: string): boolean {
    return !this.sourceTombstoned(ref) && this.readSource(access, kind, ref) !== null;
  }

  private memorySupport(ref: string): EvidenceSupport | null {
    const match = /^memory:(\d+)@(\d+)$/.exec(ref);
    if (!match) return null;
    const id = Number(match[1]);
    const revision = Number(match[2]);
    const source = this.db
      .query<{ support_valid_until: string | null }, [number, number, number, number, string]>(
        `${sourceRevisionsSql("?", "?")}
        SELECT (SELECT candidate.valid_until FROM (
          SELECT m.valid_until
          UNION ALL SELECT dependency.valid_until FROM sources s JOIN memories dependency
            ON dependency.id=s.id AND dependency.record_revision=s.revision
        ) candidate WHERE candidate.valid_until IS NOT NULL
          ORDER BY julianday(candidate.valid_until) LIMIT 1) AS support_valid_until
        FROM memories m WHERE m.id=? AND m.record_revision=? AND m.deleted_at IS NULL
          AND ${currentLifecycleSql("m", "?")}`,
      )
      .get(id, revision, id, revision, this.now());
    if (!source) return null;
    return source.support_valid_until === null
      ? UNBOUNDED_SUPPORT
      : { validUntil: new Date(source.support_valid_until).toISOString() };
  }

  registerArtifact(
    access: Access,
    input: {
      sourceRef: string;
      content: string;
      scope: Scope;
      projectKey: string | null;
      botId?: string | null;
      allowExcerpt: boolean;
      sourceEventAt?: string;
    },
  ): { sourceRef: string; sourceHash: string } {
    if (access.kind !== "owner")
      throw new MutationError("scope_denied", "Only the owner may register source artifacts");
    if (!ARTIFACT_REF.test(input.sourceRef))
      throw new MutationError("invalid_input", "Invalid artifact source reference");
    if (Buffer.byteLength(input.content, "utf8") > ARTIFACT_MAX_BYTES)
      throw new MutationError("invalid_input", "Artifact exceeds 16 KiB");
    const botId = input.botId ?? null;
    const namespace = namespaceOf({ scope: input.scope, project_key: input.projectKey, bot_id: botId });
    if (namespace === null || typeof input.allowExcerpt !== "boolean") {
      throw new MutationError("invalid_input", "Invalid artifact namespace or excerpt policy");
    }
    if (input.sourceEventAt !== undefined) EvidenceInputSchema.shape.sourceEventAt.parse(input.sourceEventAt);
    const columns = namespaceColumns(namespace);
    const sourceHash = sha256(input.content);
    this.db.transaction(() => {
      if (this.sourceTombstoned(input.sourceRef))
        throw new MutationError("context_invalidated", "Source has been forgotten");
      const prior = this.db
        .query<ArtifactRow, [string]>(`SELECT * FROM source_artifacts WHERE source_ref = ?`)
        .get(input.sourceRef);
      if (prior) {
        const priorNamespace = namespaceOf(prior);
        if (
          prior.content !== input.content ||
          prior.source_hash !== sourceHash ||
          priorNamespace === null ||
          !sameNamespace(priorNamespace, namespace) ||
          prior.allow_excerpt !== Number(input.allowExcerpt) ||
          prior.source_event_at !== (input.sourceEventAt ?? null)
        ) {
          throw new MutationError(
            "request_conflict",
            "Artifact source reference already registered with different content or policy",
          );
        }
        return;
      }
      this.db
        .query(
          `INSERT INTO source_artifacts
            (source_ref, content, source_hash, scope, project_key, bot_id, allow_excerpt, source_event_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sourceRef,
          input.content,
          sourceHash,
          columns.scope,
          columns.project_key,
          columns.bot_id,
          Number(input.allowExcerpt),
          input.sourceEventAt ?? null,
          this.now(),
        );
    })();
    return { sourceRef: input.sourceRef, sourceHash };
  }

  sourceTombstoned(sourceRef: string): boolean {
    const memory = memorySource(sourceRef);
    return (
      this.db
        .query(
          `SELECT 1 FROM memory_tombstones WHERE (kind = 'source' AND identifier = ?)
             OR (kind = 'memory' AND identifier = ?) LIMIT 1`,
        )
        .get(sourceRef, memory ? String(memory.id) : null) !== null
    );
  }

  private readSource(access: Access, kind: string, sourceRef: string): Source | null {
    if (kind === "memory") return this.readMemory(access, sourceRef);
    if (kind !== "artifact" || !ARTIFACT_REF.test(sourceRef)) return null;
    const row = this.db
      .query<ArtifactRow, [string]>(`SELECT * FROM source_artifacts WHERE source_ref = ?`)
      .get(sourceRef);
    if (!row) return null;
    const namespace = namespaceOf(row);
    if (!canRead(access, namespace)) return null;
    const hash = sha256(row.content);
    if (hash !== row.source_hash) return null;
    return {
      namespace,
      hash,
      content: row.content,
      allowExcerpt: row.allow_excerpt === 1,
      sourceEventAt: row.source_event_at,
    };
  }

  private visibleEvidence(access: Access, row: EvidenceRow): Evidence | null {
    if (this.sourceTombstoned(row.source_ref)) return null;
    if (!canRead(access, evidenceNamespace(row))) return null;
    const source = this.readSource(access, row.source_kind, row.source_ref);
    const evidence = fromRow(row);
    // Owners can inspect failed citations, but old excerpts never survive loss of their source.
    if (!source) return unavailableEvidence(access, row, evidence);
    if (row.status === "resolved" && source.hash !== row.source_hash) {
      return {
        ...evidence,
        status: "unresolved",
        reason: "source_hash_mismatch",
        sourceHash: null,
        observedAt: null,
        sourceEventAt: null,
        excerpt: null,
      };
    }
    if (!source.allowExcerpt || row.status !== "resolved") evidence.excerpt = null;
    if (evidence.excerpt !== null) evidence.excerpt = excerpt(evidence.excerpt);
    return evidence;
  }

  private readMemory(access: Access, sourceRef: string): Source | null {
    const ref = memorySource(sourceRef);
    if (!ref) return null;
    const current = this.db
      .query<
        { scope: Scope; project_key: string | null; bot_id: string | null; deleted_at: string | null },
        [number]
      >(`SELECT scope, project_key, bot_id, deleted_at FROM memories WHERE id = ?`)
      .get(ref.id);
    if (!current || current.deleted_at !== null) return null;
    const namespace = namespaceOf(current);
    if (!canRead(access, namespace)) return null;
    const revision = this.db
      .query<{ snapshot: string; legacy_metadata_unknown: number }, [number, number]>(
        `SELECT snapshot, legacy_metadata_unknown FROM memory_revisions WHERE memory_id = ? AND revision = ?`,
      )
      .get(ref.id, ref.revision);
    if (!revision) return null;
    const record = parseSnapshot(revision.snapshot);
    if (!record || !historicalSourceAllowed(access, record, revision.legacy_metadata_unknown)) return null;
    const content = `${record.title}\n${record.content}`;
    return {
      namespace,
      hash: sha256(content),
      content,
      allowExcerpt: true,
      sourceEventAt: typeof record.updated_at === "string" ? record.updated_at : null,
    };
  }
}

function unresolvedEvidence(input: EvidenceInput, storedAt: string, reason: string): Evidence {
  return {
    evidenceId: randomUUID(),
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    sourceHash: null,
    observedAt: null,
    sourceEventAt: null,
    storedAt,
    status: "unresolved",
    reason,
    excerpt: null,
  };
}

function parseSnapshot(snapshot: string): z.infer<typeof RevisionSnapshotSchema> | null {
  try {
    const parsed = RevisionSnapshotSchema.safeParse(JSON.parse(snapshot));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function memorySource(sourceRef: string): MemorySource | null {
  const match = /^memory:([1-9]\d*)@([1-9]\d*)$/.exec(sourceRef);
  if (!match) return null;
  const id = Number(match[1]);
  const revision = Number(match[2]);
  return Number.isSafeInteger(id) && Number.isSafeInteger(revision) ? { id, revision } : null;
}

function snapshotNamespace(record: z.infer<typeof RevisionSnapshotSchema>): MemoryNamespace | null {
  // Absent scope or project_key is unknown legacy metadata, never an implicit global.
  if (record.scope === undefined || record.project_key === undefined) return null;
  return namespaceOf({ scope: record.scope, project_key: record.project_key, bot_id: record.bot_id ?? null });
}

// Unknown namespaces stay owner-only: repair and inspection remain possible without a scoped grant.
function canRead(access: Access, namespace: MemoryNamespace | null): boolean {
  if (namespace === null) return access.kind === "owner";
  return access.allows("read", namespace);
}

// Evidence namespace comes from canonical namespace_bot_id; the producer bot_id is provenance only.
function evidenceNamespace(row: EvidenceRow): MemoryNamespace | null {
  return namespaceOf({ scope: row.scope, project_key: row.project_key, bot_id: row.namespace_bot_id });
}

// Unresolved or inaccessible sources store the project/null/null sentinel so no namespace is inferred.
function storedNamespace(namespace: MemoryNamespace | null): {
  scope: Scope;
  project_key: string | null;
  namespace_bot_id: string | null;
} {
  if (namespace === null) return { scope: "project", project_key: null, namespace_bot_id: null };
  const columns = namespaceColumns(namespace);
  return { scope: columns.scope, project_key: columns.project_key, namespace_bot_id: columns.bot_id };
}

function historicalSourceAllowed(
  access: Access,
  record: z.infer<typeof RevisionSnapshotSchema>,
  legacyUnknown: number,
): boolean {
  const historical = snapshotNamespace(record);
  if (historical) return access.allows("read", historical);
  return access.kind === "owner" && legacyUnknown === 1;
}

function excerpt(content: string): string {
  return redact(content).slice(0, EXCERPT_MAX_CHARS);
}

function fromRow(row: EvidenceRow): Evidence {
  return {
    evidenceId: row.evidence_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    sourceHash: row.source_hash,
    observedAt: row.observed_at,
    sourceEventAt: row.source_event_at,
    storedAt: row.stored_at,
    status: row.status,
    reason: row.reason,
    excerpt: row.excerpt,
  };
}

function resolveSource(evidence: Evidence, source: Source, input: EvidenceInput, observedAt: string): void {
  if (input.sourceHash !== undefined && input.sourceHash !== source.hash) {
    evidence.reason = "source_hash_mismatch";
    return;
  }
  evidence.status = "resolved";
  evidence.reason = null;
  evidence.sourceHash = source.hash;
  evidence.observedAt = observedAt;
  evidence.sourceEventAt = source.sourceEventAt;
  if (input.includeExcerpt && source.allowExcerpt) evidence.excerpt = excerpt(source.content);
}

function unavailableEvidence(access: Access, row: EvidenceRow, evidence: Evidence): Evidence | null {
  if (access.kind !== "owner" || row.status !== "unresolved") return null;
  return { ...evidence, excerpt: null };
}
