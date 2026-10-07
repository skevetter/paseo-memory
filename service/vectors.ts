import type { Database } from "bun:sqlite";
import type { TierSpec } from "./embedder";
import { sha256 } from "./text";

export interface VectorTarget {
  id: number;
  partition: string;
  hash: string;
}

export interface Neighbor {
  id: number;
  similarity: number;
}

export function vecTableName(model: string, dims: number): string {
  return `vec_${model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}_${dims}`;
}

export function scopeKey(scope: "global" | "project", projectKey: string | null): string {
  return scope === "global" ? "global" : `project:${sha256(projectKey ?? "").slice(0, 16)}`;
}

function blob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export class VectorIndex {
  readonly spec: TierSpec;
  readonly table: string;
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, spec: TierSpec, now: () => string) {
    this.db = db;
    this.spec = spec;
    this.now = now;
    this.table = vecTableName(spec.model, spec.dims);
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(memory_id INTEGER PRIMARY KEY,
        scope_key TEXT PARTITION KEY, embedding FLOAT[${spec.dims}] distance_metric=cosine)`,
    );
    db.query(
      `INSERT OR IGNORE INTO vec_tables (model, dims, table_name, created_at) VALUES (?, ?, ?, ?)`,
    ).run(spec.model, spec.dims, this.table, now());
  }

  write(target: VectorTarget, vector: Float32Array): void {
    const id = BigInt(target.id);
    this.db.query(`DELETE FROM ${this.table} WHERE memory_id = ?`).run(id);
    this.db
      .query(`INSERT INTO ${this.table} (memory_id, scope_key, embedding) VALUES (?, ?, ?)`)
      .run(id, target.partition, blob(vector));
    this.db
      .query(
        `INSERT INTO memory_embeddings (memory_id, model, dims, content_hash, embedded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET dims = excluded.dims, content_hash = excluded.content_hash,
           embedded_at = excluded.embedded_at`,
      )
      .run(target.id, this.spec.model, vector.length, target.hash, this.now());
  }

  knn(vector: Float32Array, partition: string, k: number): Neighbor[] {
    return this.db
      .query<{ memory_id: number; distance: number }, [Uint8Array, number, string]>(
        `SELECT memory_id, distance FROM ${this.table} WHERE embedding MATCH ? AND k = ? AND scope_key = ?`,
      )
      .all(blob(vector), k, partition)
      .map((r) => ({ id: Number(r.memory_id), similarity: 1 - r.distance }));
  }

  vector(id: number, hash: string): Float32Array | null {
    const current = this.db
      .query(`SELECT 1 FROM memory_embeddings WHERE memory_id = ? AND model = ? AND content_hash = ?`)
      .get(id, this.spec.model, hash);
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
  for (const { table_name } of vecTables(db)) {
    db.query(`DELETE FROM ${table_name} WHERE memory_id = ?`).run(BigInt(id));
  }
  db.query(`DELETE FROM memory_embeddings WHERE memory_id = ?`).run(id);
}

export function vecTables(db: Database): { model: string; dims: number; table_name: string }[] {
  return db
    .query<{ model: string; dims: number; table_name: string }, []>(
      `SELECT model, dims, table_name FROM vec_tables ORDER BY model`,
    )
    .all();
}
