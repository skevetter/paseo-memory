import type { Database } from "bun:sqlite";
import type { Scope } from "../shared/namespaces";
import type { TierSpec } from "./embedder";
import {
  assertIndexWritable,
  checkedIndexTable,
  finishModelIndex,
  indexTarget,
  registerModelIndex,
} from "./model-indexes";
import { modelIdentityFingerprint, modelIdentityJson } from "./model-manifest";
import { sha256 } from "./text";

export interface VectorTarget {
  id: number;
  partition: string;
  hash: string;
  generation: number;
}

export interface Neighbor {
  id: number;
  similarity: number;
}

function vecTableName(fingerprint: string): string {
  return `vec_${fingerprint.slice(0, 24)}`;
}

export function scopeKey(scope: Scope, projectKey: string | null, botId: string | null): string {
  if (scope === "global" && projectKey === null && botId === null) return "global";
  if (scope === "project" && projectKey && botId === null)
    return `project:${sha256(projectKey).slice(0, 16)}`;
  if (scope === "bot" && projectKey === null && botId) return `bot:${sha256(botId).slice(0, 16)}`;
  throw new Error("A vector partition requires a canonical namespace.");
}

// Anything that changes what a stored vector means for the same model name must change this value.
export function modelFingerprint(spec: TierSpec): string {
  const parts = [
    spec.model,
    spec.backend,
    spec.dtype,
    spec.pooling,
    spec.dims,
    spec.queryPrefix,
    spec.documentPrefix,
    modelIdentityFingerprint(spec.identity),
  ];
  return sha256(JSON.stringify(parts));
}

// Join to the exact immutable index before evaluating per-record generation/content freshness.
export const STALE_VECTOR_SQL = `(e.memory_id IS NULL OR e.content_hash != m.content_hash
  OR e.index_generation != m.index_generation)`;

function blob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export class VectorIndex {
  readonly spec: TierSpec;
  readonly table: string;
  readonly fingerprint: string;
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, spec: TierSpec, now: () => string) {
    this.db = db;
    this.spec = spec;
    this.now = now;
    this.fingerprint = modelFingerprint(spec);
    this.table = vecTableName(this.fingerprint);
    db.transaction(() => {
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(memory_id INTEGER PRIMARY KEY,
        scope_key TEXT PARTITION KEY, embedding FLOAT[${spec.dims}] distance_metric=cosine)`);
      registerModelIndex(
        db,
        {
          fingerprint: this.fingerprint,
          model: spec.model,
          dims: spec.dims,
          table: this.table,
          identityJson: `{"identity":${modelIdentityJson(spec.identity)},"inputs":${JSON.stringify([spec.model, spec.backend, spec.dtype, spec.pooling, spec.dims, spec.queryPrefix, spec.documentPrefix])}}`,
        },
        now(),
      );
    })();
  }

  write(target: VectorTarget, vector: Float32Array): void {
    assertIndexWritable(this.db, this.fingerprint);
    const id = BigInt(target.id);
    this.db.query(`DELETE FROM ${this.table} WHERE memory_id = ?`).run(id);
    this.db
      .query(`INSERT INTO ${this.table} (memory_id, scope_key, embedding) VALUES (?, ?, ?)`)
      .run(id, target.partition, blob(vector));
    this.db
      .query(
        `INSERT INTO memory_embeddings (memory_id,index_fingerprint,content_hash,index_generation,embedded_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(memory_id,index_fingerprint) DO UPDATE SET content_hash=excluded.content_hash,
           index_generation=excluded.index_generation,embedded_at=excluded.embedded_at`,
      )
      .run(target.id, this.fingerprint, target.hash, target.generation, this.now());
  }

  finish(): boolean {
    return finishModelIndex(this.db, this.fingerprint, this.now());
  }

  knn(vector: Float32Array, partition: string, k: number): Neighbor[] {
    return this.db
      .query<{ memory_id: number; distance: number }, [Uint8Array, number, string]>(
        `SELECT memory_id, distance FROM ${this.table} WHERE embedding MATCH ? AND k = ? AND scope_key = ?`,
      )
      .all(blob(vector), k, partition)
      .map((r) => ({ id: Number(r.memory_id), similarity: 1 - r.distance }));
  }

  vector(id: number, hash: string, generation: number): Float32Array | null {
    const current = this.db
      .query(
        `SELECT 1 FROM memory_embeddings
         WHERE memory_id = ? AND index_fingerprint = ? AND content_hash = ? AND index_generation = ?`,
      )
      .get(id, this.fingerprint, hash, generation);
    if (!current) return null;
    const row = this.db
      .query<{ embedding: Uint8Array }, [bigint]>(`SELECT embedding FROM ${this.table} WHERE memory_id = ?`)
      .get(BigInt(id));
    if (!row) return null;
    const bytes = row.embedding;
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
}

export function dropVectors(db: Database, id: number): void {
  const fingerprint = indexTarget(db);
  if (!fingerprint) return;
  const row = db
    .query<{ table_name: string | null }, [string]>(
      "SELECT table_name FROM embedding_indexes WHERE fingerprint=? AND state IN ('building','ready')",
    )
    .get(fingerprint);
  if (row?.table_name)
    db.query(`DELETE FROM ${checkedIndexTable(row.table_name)} WHERE memory_id=?`).run(BigInt(id));
  db.query("DELETE FROM memory_embeddings WHERE memory_id=? AND index_fingerprint=?").run(id, fingerprint);
}

export function purgeVectors(db: Database, id: number): void {
  for (const { table_name } of vecTables(db))
    db.query(`DELETE FROM ${checkedIndexTable(table_name)} WHERE memory_id=?`).run(BigInt(id));
  db.query("DELETE FROM memory_embeddings WHERE memory_id=?").run(id);
}

export function vecTables(db: Database): { model: string; dims: number; table_name: string }[] {
  return db
    .query<{ model: string; dims: number; table_name: string }, []>(
      `SELECT model,dims,table_name FROM embedding_indexes WHERE table_name IS NOT NULL ORDER BY model,generation`,
    )
    .all();
}
