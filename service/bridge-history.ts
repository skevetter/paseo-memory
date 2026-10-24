import type { Database } from "bun:sqlite";
import type { BridgeContextRequest } from "../shared/bridge";
import type { RetrievalResult } from "../shared/retrieval";
import type { Access } from "./access";
import { memoryContextText, renderMemoryContext } from "./context";
import { ContextBudget, type ContextEntry, type ContextTokenizer } from "./context-budget";
import type { ResolvedRetrievalPolicy } from "./retrieval-policy";
import type { HistoricalMemoryRow, MemoryStore } from "./store";

interface HistoryInput {
  db: Database;
  store: MemoryStore;
  access: Access;
  request: BridgeContextRequest & { asOf: string };
  policy: ResolvedRetrievalPolicy;
  tokenizer?: ContextTokenizer;
}

export function historicalBridgeContext(input: HistoryInput): RetrievalResult {
  const started = performance.now();
  const { store, policy, request } = input;
  const rows = historicalRows(input);
  const expired = performance.now() - started > policy.limits.maxLatencyMs;
  const entries = expired ? [] : rows.map((row) => historicalEntry(input, row));
  return new ContextBudget({
    ...policy,
    indexGeneration: store.retrievalGeneration,
    tokenizer: input.tokenizer,
    latencyMs: performance.now() - started,
    fallbackReason: expired
      ? "deadline"
      : request.budget.tokenizerId && !input.tokenizer
        ? "tokenizer_unavailable"
        : "historical_lexical",
    render: (selected, omittedPins) =>
      renderMemoryContext(selected, omittedPins, {
        project: null,
        access: input.access,
        settings: store.config,
        asOf: request.asOf,
      }),
  }).pack(entries);
}

function historicalRows(input: HistoryInput): HistoricalMemoryRow[] {
  const { access, policy, request, db, store } = input;
  if (
    policy.limits.maxCandidates === 0 ||
    policy.recordKinds.length === 0 ||
    policy.limits.maxLatencyMs === 0
  )
    return [];
  const current = access.namespaceFilter("all", "m");
  const historical = access.namespaceFilter("all", "h");
  const params: (string | number)[] = [
    request.asOf,
    request.asOf,
    ...current.params,
    ...historical.params,
    request.asOf,
    request.asOf,
    ...policy.recordKinds,
  ];
  const query = request.query.trim();
  const exact = /^#?([1-9]\d*)$/.exec(query);
  let match = "";
  if (exact?.[1]) {
    match = " AND h.memory_id=?";
    params.push(Number(exact[1]));
  } else if (query) {
    match =
      " AND (json_extract(h.snapshot,'$.title') LIKE ? ESCAPE '\\' OR json_extract(h.snapshot,'$.content') LIKE ? ESCAPE '\\' OR json_extract(h.snapshot,'$.topic_key') LIKE ? ESCAPE '\\')";
    const term = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    params.push(term, term, term);
  }
  params.push(policy.limits.maxCandidates);
  const ids = db
    .query<{ memory_id: number }, (string | number)[]>(`WITH h AS (
    SELECT r.memory_id,r.revision,r.snapshot,r.changed_at,
      json_extract(r.snapshot,'$.scope') AS scope,json_extract(r.snapshot,'$.project_key') AS project_key,
      json_extract(r.snapshot,'$.bot_id') AS bot_id FROM memory_revisions r
    WHERE json_valid(r.snapshot) AND julianday(r.changed_at)<=julianday(?)
      AND NOT EXISTS (SELECT 1 FROM memory_revisions newer WHERE newer.memory_id=r.memory_id
        AND newer.revision>r.revision AND julianday(newer.changed_at)<=julianday(?)))
    SELECT h.memory_id FROM h JOIN memories m ON m.id=h.memory_id
    WHERE ${current.where} AND ${historical.where}
      AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.kind='memory' AND t.identifier=CAST(h.memory_id AS TEXT))
      AND json_extract(h.snapshot,'$.state')='active' AND json_extract(h.snapshot,'$.deleted_at') IS NULL
      AND (json_extract(h.snapshot,'$.valid_from') IS NULL OR julianday(json_extract(h.snapshot,'$.valid_from'))<=julianday(?))
      AND (json_extract(h.snapshot,'$.valid_until') IS NULL OR julianday(json_extract(h.snapshot,'$.valid_until'))>julianday(?))
      AND json_extract(h.snapshot,'$.record_kind') IN (${policy.recordKinds.map(() => "?").join(",")})${match}
    ORDER BY julianday(h.changed_at) DESC,h.memory_id LIMIT ?`)
    .all(...params);
  return ids.flatMap(({ memory_id }) => {
    const row = store.historical(access, memory_id, request.asOf);
    return row ? [row] : [];
  });
}

function historicalEntry(input: HistoryInput, row: HistoricalMemoryRow): ContextEntry {
  const ids = input.db
    .query<{ evidence_id: string }, [number, number]>(
      "SELECT evidence_id FROM memory_evidence_links WHERE memory_id=? AND revision=? ORDER BY evidence_id",
    )
    .all(row.id, row.record_revision)
    .map((link) => link.evidence_id);
  const evidence = input.store.provenance.getVisible(input.access, ids);
  return {
    ...memoryContextText(row, evidence, input.policy.detail),
    key: `memory:${row.id}`,
    memoryRef: { id: row.id, revision: row.record_revision },
    sessionId: null,
    section: "Historical facts",
    priority: row.pinned ? 0 : row.record_kind === "preference" ? 1 : 2,
    score: Date.parse(row.updated_at),
    diversityKey: row.topic_key ?? row.title.normalize("NFC").toLowerCase(),
    pinned: row.pinned === 1,
    task: false,
  };
}
