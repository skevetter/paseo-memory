import type { Database } from "bun:sqlite";
import type { ForgetPreview, MemoryRef } from "../shared/lifecycle";
import type { Access } from "./access";
import { dropVectors } from "./vectors";

const DISCLOSURES_SQL = `WITH RECURSIVE disclosed(nonce,memory_id) AS (
  SELECT e.nonce,CAST(j.value AS INTEGER) FROM audit_events e,json_each(e.detail,'$.memories') j WHERE e.kind IN ('inject','context')
  UNION SELECT e.nonce,CAST(j.value AS INTEGER) FROM audit_events e,json_each(e.detail,'$.found') j WHERE e.kind='get'
  UNION SELECT e.nonce,CAST(json_extract(j.value,'$.id') AS INTEGER) FROM audit_events e,json_each(e.detail,'$.results') j WHERE e.kind='search'
  UNION SELECT e.nonce,CAST(json_extract(e.detail,'$.id') AS INTEGER) FROM audit_events e WHERE e.kind IN ('save','update','delete')
)`;

/** SQL predicates also gate candidates before inference, not just the final response. */
export function currentLifecycleSql(alias = "m", at = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"): string {
  return `EXISTS (SELECT 1 FROM (SELECT ${at} AS at) lifecycle_clock WHERE
    ${alias}.state='active'
    AND (${alias}.valid_from IS NULL OR julianday(${alias}.valid_from)<=julianday(lifecycle_clock.at))
    AND (${alias}.valid_until IS NULL OR julianday(${alias}.valid_until)>julianday(lifecycle_clock.at))
    AND (NOT EXISTS (SELECT 1 FROM lifecycle_invalidations) OR (${alias}.record_kind!='derived_summary'
      AND NOT EXISTS (SELECT 1 FROM memory_relations lr WHERE lr.to_id=${alias}.id AND lr.kind='derived_from')))
    AND NOT EXISTS (
      ${sourceRevisionsSql(`${alias}.id`, `${alias}.record_revision`)}
      SELECT 1 FROM sources s LEFT JOIN memories dependency ON dependency.id=s.id
      WHERE dependency.id IS NULL OR dependency.record_revision!=s.revision OR dependency.state!='active'
        OR dependency.deleted_at IS NOT NULL
        OR (dependency.valid_from IS NOT NULL AND julianday(dependency.valid_from)>julianday(lifecycle_clock.at))
        OR (dependency.valid_until IS NOT NULL AND julianday(dependency.valid_until)<=julianday(lifecycle_clock.at))
        OR (SELECT count(*) FROM sources)>=1025
    ))`;
}

function sourceRevisionsSql(id: string, revision: string): string {
  return `WITH RECURSIVE sources(id,revision) AS (
    SELECT r.from_id,r.from_revision FROM memory_relations r
      WHERE r.to_id=${id} AND r.to_revision=${revision} AND r.kind='derived_from'
    UNION SELECT r.from_id,r.from_revision FROM sources s JOIN memory_relations r
      ON r.to_id=s.id AND r.to_revision=s.revision WHERE r.kind='derived_from' LIMIT 1025
  )`;
}

export class Lifecycle {
  private timer: Timer | undefined;
  private closed = false;
  constructor(
    private readonly db: Database,
    private readonly now: () => string,
  ) {}

  contextInvalidated(identity: {
    nonce?: string | null;
    agentId?: string | null;
    principalId?: string;
  }): boolean {
    const { nonce, agentId, principalId } = identity;
    return Boolean(
      this.db
        .query(`SELECT 1 FROM memory_tombstones t WHERE
      (t.kind='caller' AND t.identifier=?)
      OR (t.kind='session' AND t.identifier=?)
      OR (t.kind='principal' AND t.identifier=?)
      OR (t.kind='caller' AND t.identifier IN (SELECT nonce FROM agent_links WHERE agent_id=?))
      OR (t.kind='session' AND t.identifier IN (SELECT agent_id FROM agent_links WHERE nonce=?))
      LIMIT 1`)
        .get(nonce ?? null, agentId ?? null, principalId ?? null, agentId ?? null, nonce ?? null),
    );
  }

  private exposedContexts(ids: number[]): { agents: string[]; nonces: string[] } {
    const placeholders = ids.map(() => "?").join(",");
    const nodes = this.db
      .prepare<{ kind: string; identifier: string }, number[]>(`${DISCLOSURES_SQL},
      session_disclosed(nonce,session_id) AS (
        SELECT e.nonce,CAST(j.value AS TEXT) FROM audit_events e,json_each(e.detail,'$.sessions') j
          WHERE e.kind IN ('inject','context')
        UNION SELECT e.nonce,substr(json_extract(j.value,'$.id'),9)
          FROM audit_events e,json_each(e.detail,'$.results') j
          WHERE e.kind='search' AND json_extract(j.value,'$.id') LIKE 'session:%'
      ), exposed(kind,identifier) AS (
        SELECT 'caller',nonce FROM disclosed WHERE memory_id IN (${placeholders}) AND nonce IS NOT NULL
        UNION SELECT 'agent',agent_id FROM memories WHERE id IN (${placeholders}) AND agent_id IS NOT NULL
        UNION SELECT 'agent',a.agent_id FROM exposed x JOIN agent_links a
          ON x.kind='caller' AND a.nonce=x.identifier WHERE a.agent_id IS NOT NULL
        UNION SELECT 'caller',a.nonce FROM exposed x JOIN agent_links a
          ON x.kind='agent' AND a.agent_id=x.identifier
        UNION SELECT 'session',identifier FROM exposed WHERE kind='agent'
        UNION SELECT 'session',s.id FROM exposed x JOIN sessions s
          ON x.kind='agent' AND s.agent_id=x.identifier
        UNION SELECT 'caller',d.nonce FROM exposed x JOIN session_disclosed d
          ON x.kind='session' AND d.session_id=x.identifier WHERE d.nonce IS NOT NULL
        LIMIT 10001
      ) SELECT kind,identifier FROM exposed`)
      .all(...ids, ...ids);
    if (nodes.length > 10000)
      throw new Error("Forget affects more than 10000 context graph nodes; maintenance is required.");
    return {
      agents: nodes.filter((node) => node.kind === "agent").map((node) => node.identifier),
      nonces: nodes.filter((node) => node.kind === "caller").map((node) => node.identifier),
    };
  }

  historicalSourcesValid(ref: MemoryRef, asOf: string): boolean {
    const invalid = this.db
      .query<{ invalid: number }, [number, number, string]>(`${sourceRevisionsSql("?", "?")}
      SELECT EXISTS (
        SELECT 1 FROM sources s LEFT JOIN memories current ON current.id=s.id
        LEFT JOIN memory_revisions r ON r.memory_id=s.id AND r.revision=s.revision
        CROSS JOIN (SELECT ? AS at) clock
        WHERE current.id IS NULL OR r.snapshot IS NULL OR julianday(r.changed_at)>julianday(clock.at)
          OR json_extract(r.snapshot,'$.state') IS NOT 'active'
          OR json_extract(r.snapshot,'$.deleted_at') IS NOT NULL
          OR (json_extract(r.snapshot,'$.valid_from') IS NOT NULL AND julianday(json_extract(r.snapshot,'$.valid_from'))>julianday(clock.at))
          OR (json_extract(r.snapshot,'$.valid_until') IS NOT NULL AND julianday(json_extract(r.snapshot,'$.valid_until'))<=julianday(clock.at))
          OR EXISTS (SELECT 1 FROM memory_revisions later WHERE later.memory_id=s.id AND later.revision>s.revision AND julianday(later.changed_at)<=julianday(clock.at))
          OR (SELECT count(*) FROM sources)>=1025
      ) AS invalid`)
      .get(ref.id, ref.revision, asOf);
    return invalid?.invalid === 0;
  }

  resume(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.drain();
      if (this.db.query("SELECT 1 FROM lifecycle_invalidations LIMIT 1").get()) this.resume();
    }, 0);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** Queue first: deeper dependents cannot be recalled while bounded propagation remains pending. */
  invalidate(ref: MemoryRef): void {
    this.db
      .query("INSERT OR IGNORE INTO lifecycle_invalidations VALUES (?, ?, ?)")
      .run(ref.id, ref.revision, this.now());
    this.drain();
    this.resume();
  }

  private drain(): void {
    this.db.transaction(() => {
      const pending = this.db
        .query<MemoryRef, []>(
          "SELECT memory_id AS id, revision FROM lifecycle_invalidations ORDER BY created_at, memory_id LIMIT 128",
        )
        .all();
      let remaining = 128;
      for (const ref of pending) {
        if (remaining === 0) break;
        remaining -= this.processInvalidation(ref, remaining);
      }
    })();
  }

  private processInvalidation(ref: MemoryRef, remaining: number): number {
    const children = this.db
      .query<{ id: number; record_revision: number }, [number, number, number]>(
        `SELECT DISTINCT m.id,m.record_revision FROM memory_relations r JOIN memories m ON m.id=r.to_id
       WHERE r.from_id=? AND r.from_revision=? AND r.kind='derived_from'
       AND r.to_revision=m.record_revision AND m.state IN ('active','candidate') LIMIT ?`,
      )
      .all(ref.id, ref.revision, remaining);
    for (const row of children) {
      this.markForRecheck({ id: row.id, revision: row.record_revision });
      this.db
        .query("INSERT OR IGNORE INTO lifecycle_invalidations VALUES (?, ?, ?)")
        .run(row.id, row.record_revision, this.now());
    }
    this.db
      .query(`UPDATE review_jobs SET state='cancelled',lease_version=lease_version+1,updated_at=?
      WHERE state IN ('queued','running','reserved') AND id IN
      (SELECT job_id FROM review_job_sources WHERE memory_id=? AND revision=?)`)
      .run(this.now(), ref.id, ref.revision);
    if (children.length < remaining)
      this.db
        .query("DELETE FROM lifecycle_invalidations WHERE memory_id=? AND revision=?")
        .run(ref.id, ref.revision);
    return children.length;
  }

  markForRecheck(ref: MemoryRef): void {
    this.db
      .query(`UPDATE memories SET state='needs_recheck',verification_status='unresolved',verified_at=NULL,
      record_revision=record_revision+1,index_generation=index_generation+1,updated_at=? WHERE id=? AND record_revision=?`)
      .run(this.now(), ref.id, ref.revision);
    this.db
      .query(`INSERT OR IGNORE INTO memory_evidence_links
      SELECT memory_id,?,evidence_id,relationship FROM memory_evidence_links WHERE memory_id=? AND revision=?`)
      .run(ref.revision + 1, ref.id, ref.revision);
    this.db
      .query(`INSERT OR IGNORE INTO memory_relations
      SELECT from_id,from_revision,to_id,?,kind,actor_id,created_at,verification_status
      FROM memory_relations WHERE to_id=? AND to_revision=?`)
      .run(ref.revision + 1, ref.id, ref.revision);
    dropVectors(this.db, ref.id);
  }

  preview(access: Access, id: number): ForgetPreview {
    return this.erasurePlan(access, id).preview;
  }

  erasurePlan(access: Access, id: number): { preview: ForgetPreview; nonces: string[] } {
    if (access.kind !== "owner") throw new Error("Only the owner can preview source erasure.");
    const root = this.db
      .query<{ scope: "global" | "project"; project_key: string | null }, [number]>(
        "SELECT scope, project_key FROM memories WHERE id = ?",
      )
      .get(id);
    if (!root || !access.allows("delete", { scope: root.scope, projectKey: root.project_key }))
      throw new Error("Memory is unavailable.");
    // UNION deduplicates cycles. A bounded preview fails rather than silently claiming partial erasure.
    const records = this.db
      .query<{ id: number; revision: number }, [number]>(`WITH RECURSIVE affected(id) AS (
      SELECT ? UNION SELECT r.to_id FROM memory_relations r JOIN affected a ON r.from_id = a.id WHERE r.kind = 'derived_from'
      UNION SELECT sibling.memory_id FROM affected a JOIN memory_evidence_links own ON own.memory_id=a.id
        JOIN memory_evidence e ON e.evidence_id=own.evidence_id JOIN memory_evidence shared ON shared.source_ref=e.source_ref
        JOIN memory_evidence_links sibling ON sibling.evidence_id=shared.evidence_id
      UNION SELECT dependent.memory_id FROM affected a JOIN memory_evidence e
        ON e.source_kind='memory' AND e.source_ref LIKE ('memory:' || a.id || '@%')
        JOIN memory_evidence_links dependent ON dependent.evidence_id=e.evidence_id LIMIT 10001
    ) SELECT m.id, m.record_revision AS revision FROM affected a JOIN memories m ON m.id = a.id`)
      .all(id);
    if (records.length > 10000)
      throw new Error("Forget affects more than 10000 records; maintenance is required before erasure.");
    const ids = records.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const evidence = this.db
      .prepare<
        { evidence_id: string; source_ref: string },
        number[]
      >(`SELECT DISTINCT e.evidence_id, e.source_ref
      FROM memory_evidence e LEFT JOIN memory_evidence_links l ON l.evidence_id = e.evidence_id
      WHERE l.memory_id IN (${placeholders}) OR EXISTS (SELECT 1 FROM memories m WHERE m.id IN (${placeholders})
        AND e.source_kind='memory' AND e.source_ref LIKE ('memory:' || m.id || '@%'))`)
      .all(...ids, ...ids);
    const contexts = this.exposedContexts(ids);
    return {
      nonces: contexts.nonces,
      preview: {
        records,
        evidenceIds: [...new Set(evidence.map((e) => e.evidence_id))],
        sources: [...new Set(evidence.map((e) => e.source_ref))],
        affectedAgentIds: contexts.agents,
        limits: [
          "External sources and exported backups are separate copies.",
          "Already attached prompts, host history and provider requests cannot be retracted. Affected sessions need fresh authorized context; host-history deletion or restart is separate.",
          "Affected Memory session digests and audit disclosures are purged. Capture and standalone review stay blocked for those agent IDs; start a fresh agent context.",
        ],
      },
    };
  }
}
