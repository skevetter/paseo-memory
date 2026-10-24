import type { Database } from "bun:sqlite";

export const INDEX_RETENTION = { maxRetired: 2, retiredDays: 7 } as const;
export interface ModelIndexRow {
  fingerprint: string;
  generation: number;
  model: string;
  dims: number;
  table_name: string | null;
  identity_json: string | null;
  state: "building" | "ready" | "retired" | "legacy";
  created_at: string | null;
  ready_at: string | null;
  retired_at: string | null;
}
interface IndexRegistration {
  fingerprint: string;
  model: string;
  dims: number;
  table: string;
  identityJson: string;
}

export function indexTarget(db: Database): string | null {
  return (
    db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='embedding_target_fingerprint'").get()
      ?.value ?? null
  );
}
export function selectIndexTarget(db: Database, fingerprint: string | null): void {
  if (indexTarget(db) === fingerprint) return;
  if (fingerprint === null) {
    db.query("DELETE FROM meta WHERE key='embedding_target_fingerprint'").run();
    return;
  }
  db.query(
    "INSERT INTO meta(key,value) VALUES ('embedding_target_fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(fingerprint);
}
export function registerModelIndex(db: Database, input: IndexRegistration, at: string): void {
  const existing = db
    .query<ModelIndexRow, [string]>("SELECT * FROM embedding_indexes WHERE fingerprint=?")
    .get(input.fingerprint);
  if (existing) {
    if (
      existing.model !== input.model ||
      existing.dims !== input.dims ||
      existing.table_name !== input.table ||
      existing.identity_json !== input.identityJson
    )
      throw new Error("Immutable model index identity conflicts with its catalog entry.");
    db.query(
      "UPDATE embedding_indexes SET state='building',retired_at=NULL WHERE fingerprint=? AND state='retired'",
    ).run(input.fingerprint);
  } else {
    const generation = db
      .query<{ value: string }, []>(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='embedding_index_generation' RETURNING value",
      )
      .get()?.value;
    if (!generation || !Number.isSafeInteger(Number(generation)))
      throw new Error("Model index generation is unavailable.");
    db.query(
      "INSERT INTO embedding_indexes(fingerprint,generation,model,dims,table_name,identity_json,state,created_at) VALUES(?,?,?,?,?,?,'building',?)",
    ).run(
      input.fingerprint,
      Number(generation),
      input.model,
      input.dims,
      input.table,
      input.identityJson,
      at,
    );
  }
  selectIndexTarget(db, input.fingerprint);
}
export function assertIndexWritable(db: Database, fingerprint: string): void {
  const writable = db
    .query(
      "SELECT 1 FROM embedding_indexes WHERE fingerprint=? AND state IN ('building','ready') AND fingerprint=(SELECT value FROM meta WHERE key='embedding_target_fingerprint')",
    )
    .get(fingerprint);
  if (!writable)
    throw new Error("This model index is read-only; only the current target may receive derived vectors.");
}
export function finishModelIndex(db: Database, fingerprint: string, at: string): boolean {
  return db.transaction(() => {
    if (indexTarget(db) !== fingerprint) return false;
    db.query(
      "UPDATE embedding_indexes SET state='retired',retired_at=coalesce(retired_at,?) WHERE fingerprint!=? AND state IN ('ready','building','legacy')",
    ).run(at, fingerprint);
    db.query(
      "UPDATE embedding_indexes SET state='ready',ready_at=CASE WHEN state='ready' THEN ready_at ELSE ? END,retired_at=NULL WHERE fingerprint=?",
    ).run(at, fingerprint);
    db.query(
      "INSERT INTO meta(key,value) VALUES ('embedding_ready_fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(fingerprint);
    pruneRetiredIndexes(db, at);
    return true;
  })();
}
export function pruneRetiredIndexes(db: Database, at: string): number {
  const cutoff = Date.parse(at) - INDEX_RETENTION.retiredDays * 86400000;
  const retired = db
    .query<ModelIndexRow, []>(
      "SELECT * FROM embedding_indexes WHERE state='retired' ORDER BY retired_at DESC,created_at DESC,generation DESC",
    )
    .all();
  let removed = 0;
  for (const [position, index] of retired.entries()) {
    if (position < INDEX_RETENTION.maxRetired && index.retired_at && Date.parse(index.retired_at) >= cutoff)
      continue;
    if (index.table_name) db.run(`DROP TABLE ${checkedIndexTable(index.table_name)}`);
    db.query("DELETE FROM embedding_indexes WHERE fingerprint=?").run(index.fingerprint);
    removed++;
  }
  return removed;
}
export function modelIndexes(db: Database): ModelIndexRow[] {
  return db.query<ModelIndexRow, []>("SELECT * FROM embedding_indexes ORDER BY generation DESC").all();
}
export function checkedIndexTable(name: string): string {
  if (!/^vec_[a-z0-9_]+$/.test(name))
    throw new Error("Model index table name is invalid; maintenance is required.");
  return name;
}
