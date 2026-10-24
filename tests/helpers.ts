import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "../service/access";
import type { Embedder, TierSpec } from "../service/embedder";
import type { ModelIdentity } from "../service/model-manifest";
import type { MemoryStore, ProjectRef } from "../service/store";
import { sha256 } from "../service/text";

export const dataRepo: ProjectRef = {
  key: "remote:gitlab.com/h3upperbounds/data/data-team",
  name: "data/data-team",
  rootPath: "/home/u/h3/data-team",
  paseoProjectId: "prj_aaaa",
};

export const otherRepo: ProjectRef = {
  key: "remote:github.com/skevetter/devsy",
  name: "skevetter/devsy",
  rootPath: "/Users/u/devsy",
  paseoProjectId: "prj_bbbb",
};

export const owner = Access.owner();

const created: string[] = [];

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "pm-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Identity fixture for deterministic hash/scoring backends, not native-model evidence.
export function fixtureModelIdentity(
  model: string,
  dims = 1,
  task: "embedding" | "reranking" = "embedding",
): ModelIdentity {
  const revision = sha256(`fixture:${model}`).slice(0, 40);
  return {
    schemaVersion: 1,
    model,
    modelRevision: revision,
    tokenizerRevision: revision,
    artifacts: [{ path: "fixture.bin", revision, sha256: sha256("0"), size: 1 }],
    runtime: {
      implementation: "paseo-model2vec-v1",
      transformers: null,
      transformersSha256: null,
      tokenizers: null,
      onnxruntimeNode: null,
      onnxruntimeCommon: null,
      engine: "bun",
      engineVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
      unicode: process.versions.unicode ?? null,
      icu: process.versions.icu ?? null,
      executionProvider: null,
    },
    preprocessing: {
      task,
      implementation: `fixture-${task}-v1`,
      dtype: "fp32",
      dims,
      pooling: task === "embedding" ? "mean" : "none",
      normalization: task === "embedding" ? "l2" : "none",
      queryPrefix: "",
      documentPrefix: "",
      maxInputChars: null,
      maxDocumentChars: null,
      maxPairTokens: null,
      padding: false,
      truncation: false,
      scoreTransform: "none",
    },
  };
}

export function hashSpec(model: string, dims: number): TierSpec {
  return {
    tier: "zero",
    model,
    backend: "model2vec",
    dtype: "fp32",
    pooling: "mean",
    dims,
    identity: fixtureModelIdentity(model, dims),
    queryPrefix: "",
    documentPrefix: "",
    duplicateThreshold: 0.9,
    searchFloor: { min: 0.2, relative: 0.5 },
    taskFloor: { low: 0.2, medium: 0.4, high: 0.6 },
  };
}

export function hashEmbedder(model = "test/hash", dims = 64): Embedder & { calls: number } {
  const embedder = {
    spec: hashSpec(model, dims),
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += texts.length;
      return texts.map((text) => {
        const vector = new Float32Array(dims);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const slot = Number.parseInt(sha256(word).slice(0, 8), 16) % dims;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((x) => x / norm);
      });
    },
  };
  return embedder;
}

export function mergeRequest(store: MemoryStore, sourceId: number, targetId: number) {
  const revision = (id: number) => store.getVisible(owner, [id])[0]?.record_revision ?? -1;
  return { sourceId, targetId, sourceRevision: revision(sourceId), targetRevision: revision(targetId) };
}

export function removePostV6Schema(db: Database): void {
  db.transaction(() => {
    db.run("DROP TRIGGER memory_revision_ai; DROP TRIGGER memory_revision_au;");
    if (
      db
        .query(
          `SELECT 1 FROM memory_embeddings e JOIN embedding_indexes i ON i.fingerprint=e.index_fingerprint GROUP BY e.memory_id,i.model HAVING count(*)>1`,
        )
        .get() ||
      db.query(`SELECT 1 FROM embedding_indexes GROUP BY model,dims HAVING count(*)>1`).get()
    )
      throw new Error("This historical fixture cannot represent multiple fingerprints for one model.");
    db.run(`CREATE TABLE vec_tables(model TEXT NOT NULL,dims INTEGER NOT NULL,table_name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,PRIMARY KEY(model,dims));
      CREATE TABLE memory_embeddings_v6(memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,model TEXT NOT NULL,dims INTEGER NOT NULL,
       content_hash TEXT NOT NULL,embedded_at TEXT NOT NULL,index_generation INTEGER NOT NULL DEFAULT 0,model_fingerprint TEXT NOT NULL DEFAULT '',PRIMARY KEY(memory_id,model));
      INSERT INTO memory_embeddings_v6 SELECT e.memory_id,i.model,i.dims,e.content_hash,e.embedded_at,e.index_generation,coalesce(e.legacy_model_fingerprint,e.index_fingerprint)
       FROM memory_embeddings e JOIN embedding_indexes i ON i.fingerprint=e.index_fingerprint;`);
    restoreLegacyVectorTables(db);
    db.run(`DROP TABLE memory_embeddings;ALTER TABLE memory_embeddings_v6 RENAME TO memory_embeddings;
      DROP TABLE embedding_indexes;DROP TABLE model_usage;DROP INDEX ix_audit_retrieval;
      DELETE FROM meta WHERE key IN ('embedding_index_generation','embedding_target_fingerprint','embedding_ready_fingerprint','resource_observation_epoch');`);
    for (const table of [
      "memory_revisions",
      "memory_evidence",
      "memory_evidence_links",
      "memory_relations",
      "memory_mutations",
      "memory_feedback",
      "review_jobs",
      "review_job_sources",
      "lifecycle_invalidations",
      "memory_tombstones",
      "source_artifacts",
    ])
      db.run(`DROP TABLE ${table}`);
    for (const column of [
      "last_retrieved_at",
      "application_count",
      "validated_helpful_count",
      "validated_harmful_count",
      "record_kind",
      "state",
      "verification_status",
      "valid_from",
      "valid_until",
      "verified_at",
    ])
      db.run(`ALTER TABLE memories DROP COLUMN ${column}`);
  }).immediate();
}

function restoreLegacyVectorTables(db: Database): void {
  const indexes = db
    .query<{ generation: number; model: string; dims: number; table_name: string | null }, []>(
      "SELECT generation,model,dims,table_name FROM embedding_indexes",
    )
    .all();
  for (const index of indexes) {
    if (!index.table_name) continue;
    if (!/^vec_[a-z0-9_]+$/.test(index.table_name) || !Number.isSafeInteger(index.dims) || index.dims < 1)
      throw new Error("Invalid historical vector fixture.");
    const table = `vec_fixture_legacy_${index.generation}`;
    db.run(`CREATE VIRTUAL TABLE ${table} USING vec0(memory_id INTEGER PRIMARY KEY,scope_key TEXT PARTITION KEY,embedding FLOAT[${index.dims}] distance_metric=cosine);
      INSERT INTO ${table}(memory_id,scope_key,embedding) SELECT memory_id,scope_key,embedding FROM ${index.table_name};
      DROP TABLE ${index.table_name};`);
    db.query("INSERT INTO vec_tables VALUES(?,?,?,?)").run(
      index.model,
      index.dims,
      table,
      "2026-01-01T00:00:00.000Z",
    );
  }
}
