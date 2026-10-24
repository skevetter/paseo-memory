import type { Database } from "bun:sqlite";

// Called inside the same owner erasure transaction, before any success receipt can escape.
export function eraseBridgeCopies(
  db: Database,
  now: string,
  eraseContexts: (agents: string[]) => void,
): void {
  const agents = db
    .query<
      { agent_id: string },
      []
    >(`SELECT DISTINCT coalesce(b.actual_agent_id,b.intended_agent_id) AS agent_id
    FROM bridge_sessions b WHERE
      (b.state<>'revoked' OR EXISTS (SELECT 1 FROM bridge_contexts c WHERE c.session_id=b.session_id AND c.context_json IS NOT NULL)
        OR EXISTS (SELECT 1 FROM bridge_events e WHERE e.session_id=b.session_id AND e.event_json IS NOT NULL))
      AND (EXISTS (SELECT 1 FROM memory_tombstones t WHERE
        (t.kind='session' AND t.identifier IN (b.intended_agent_id,b.actual_agent_id))
        OR (t.kind='caller' AND t.identifier=('bridge:' || b.session_id || ':' || b.session_epoch)))
      OR EXISTS (SELECT 1 FROM bridge_contexts c,json_each(c.memory_refs) r JOIN memory_tombstones t
        ON t.kind='memory' AND CAST(t.identifier AS INTEGER)=json_extract(r.value,'$.id') WHERE c.session_id=b.session_id)
      OR EXISTS (SELECT 1 FROM bridge_events e JOIN bridge_event_sources s ON s.event_id=e.id
        JOIN memory_tombstones t ON (t.kind='memory' AND s.memory_id=CAST(t.identifier AS INTEGER))
          OR (t.kind='source' AND s.source_ref=t.identifier)
        WHERE e.session_id=b.session_id AND e.processing_state<>'invalidated'))`)
    .all()
    .map((row) => row.agent_id);
  if (agents.length) eraseContexts(agents);
  const affected = `SELECT b.session_id FROM bridge_sessions b WHERE EXISTS (
    SELECT 1 FROM memory_tombstones t WHERE
      (t.kind='session' AND t.identifier IN (b.intended_agent_id,b.actual_agent_id))
      OR (t.kind='caller' AND t.identifier=('bridge:' || b.session_id || ':' || b.session_epoch)))`;
  db.query(`UPDATE bridge_contexts SET context_json=NULL,memory_refs='[]',evidence_refs='[]',source_snapshot='null',
    invalidated_at=coalesce(invalidated_at,?) WHERE session_id IN (${affected})`).run(now);
  db.query(`UPDATE bridge_events SET event_json=NULL,processing_state='invalidated',last_error='source_forgotten'
    WHERE session_id IN (${affected})`).run();
  db.query(
    `UPDATE bridge_leases SET revoked_at=coalesce(revoked_at,?) WHERE session_id IN (${affected})`,
  ).run(now);
  db.query(`UPDATE bridge_sessions SET state='revoked',tool_revoked_at=coalesce(tool_revoked_at,?),updated_at=?
    WHERE session_id IN (${affected}) AND state<>'revoked'`).run(now, now);
}
