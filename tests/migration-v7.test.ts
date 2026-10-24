import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "../service/schema";
import { openDatabase } from "../service/sqlite";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path: string): Database {
  const { db } = openDatabase(path);
  databases.push(db);
  return db;
}

function newPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pm-v7-"));
  directories.push(directory);
  return join(directory, "memory.db");
}

const originalTime = "2025-03-01T00:00:00Z";
const currentTime = "2026-02-01T00:00:00Z";

// Independent historical fixtures: never create a current DB and pretend it is old by changing user_version.
function legacy(version: number, path = newPath()): { db: Database; path: string } {
  const db = open(path);
  db.run(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_key TEXT REFERENCES projects(key), type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      topic_key TEXT, content_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      revision_count INTEGER NOT NULL DEFAULT 1, duplicate_count INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'agent', agent_id TEXT, provider TEXT, workspace_dir TEXT, branch TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT, deleted_at TEXT);
    CREATE TABLE memory_versions (memory_id INTEGER NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(memory_id, version));
    CREATE TABLE sessions (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_key TEXT, agent_id TEXT NOT NULL,
      provider TEXT, title TEXT, workspace_dir TEXT, first_prompt TEXT, last_prompt TEXT, last_reply TEXT,
      files TEXT NOT NULL DEFAULT '[]', turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE agent_links (nonce TEXT PRIMARY KEY, agent_id TEXT, workspace_id TEXT, project_key TEXT, provider TEXT,
      title TEXT, created_at TEXT NOT NULL, linked_at TEXT);
    INSERT INTO projects VALUES ('project-a', 'Project A', '/a', '${originalTime}', '${currentTime}');
    INSERT INTO memories (id, scope, project_key, type, title, content, content_hash, revision_count, pinned,
      duplicate_count, source, agent_id, provider, workspace_dir, branch, created_at, updated_at, last_seen_at, deleted_at)
      VALUES (41, 'project', 'project-a', 'decision', 'Current title', 'Current content', 'current-hash', 4, 1,
        3, 'owner', 'agent-a', 'provider-a', '/a', 'main', '${originalTime}', '${currentTime}', '${currentTime}', NULL),
        (83, 'global', NULL, 'bugfix', 'Deleted memory', 'Retained history', 'deleted-hash', 1, 0,
        1, 'agent', NULL, NULL, NULL, NULL, '${originalTime}', '${currentTime}', NULL, '${currentTime}');
    INSERT INTO memory_versions VALUES
      (41, 1, 'First title', 'First content', '${originalTime}'),
      (41, 2, 'Second title', 'Second content', '2025-04-01T00:00:00Z'),
      (41, 3, 'Third title', 'Third content', '2025-05-01T00:00:00Z');
  `);
  if (version === 1) {
    db.run(`CREATE TABLE memory_embeddings (memory_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
      INSERT INTO memory_embeddings VALUES (41, 'legacy-vector', 2, x'0000803f00000000');`);
  } else {
    db.run(`CREATE TABLE memory_embeddings (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      model TEXT NOT NULL, dims INTEGER NOT NULL, content_hash TEXT NOT NULL, embedded_at TEXT NOT NULL,
      PRIMARY KEY(memory_id, model));
      INSERT INTO memory_embeddings VALUES (41, 'old-model', 2, 'current-hash', '${currentTime}');`);
  }
  if (version >= 3) {
    db.run(`CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX ix_audit_nonce ON audit_events(nonce,id);
      CREATE INDEX ix_audit_created ON audit_events(created_at);`);
    db.run(`ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN last_used_at TEXT;
      ALTER TABLE memories ADD COLUMN merged_into INTEGER;
      UPDATE memories SET use_count = 9, last_used_at = '${currentTime}', merged_into = 41 WHERE id = 83;`);
  }
  if (version >= 4) {
    db.run(`ALTER TABLE memories ADD COLUMN shown_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN opened_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN kept_at TEXT;
      ALTER TABLE memories ADD COLUMN archived_at TEXT;
      ALTER TABLE sessions ADD COLUMN summary TEXT;
      ALTER TABLE sessions ADD COLUMN outcomes TEXT;
      ALTER TABLE sessions ADD COLUMN reviewed_at TEXT;
      ALTER TABLE agent_links ADD COLUMN tools INTEGER NOT NULL DEFAULT 1;
      UPDATE memories SET shown_count = 12, opened_count = 5, kept_at = '${originalTime}', archived_at = '${currentTime}' WHERE id = 83;`);
  }
  if (version === 6) {
    db.run(`CREATE TABLE vec_tables(model TEXT NOT NULL,dims INTEGER NOT NULL,table_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,PRIMARY KEY(model,dims));`);
    db.run(`ALTER TABLE memories ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE memories ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE memory_embeddings ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_embeddings ADD COLUMN model_fingerprint TEXT NOT NULL DEFAULT '';
      UPDATE memories SET record_revision = 9, index_generation = 17 WHERE id = 41;
      UPDATE memory_embeddings SET index_generation = 17, model_fingerprint = 'pinned-model';`);
  }
  db.run(`PRAGMA user_version = ${version}`);
  return { db, path };
}

function row(db: Database, id = 41): Record<string, unknown> {
  return db.query<Record<string, unknown>, [number]>(`SELECT * FROM memories WHERE id = ?`).get(id) ?? {};
}

interface Revision {
  revision: number;
  snapshot: string;
  changed_at: string;
  actor_id: string | null;
  reason: string | null;
  legacy_metadata_unknown: number;
}

function revisions(db: Database, id = 41): Revision[] {
  return db
    .query<Revision, [number]>(`SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision`)
    .all(id);
}

function version(db: Database): number | undefined {
  return db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version;
}

describe("schema v7 migration", () => {
  for (const sourceVersion of [0, 1, 2, 3, 4, 5, 6]) {
    it(`preserves identities, metadata and honest history from v${sourceVersion}`, () => {
      const { db } = legacy(sourceVersion);
      const before = [row(db), row(db, 83)];
      migrate(db);
      expect(version(db)).toBe(SCHEMA_VERSION);
      for (const prior of before) expect(row(db, Number(prior.id))).toMatchObject(prior);
      expect(row(db)).toMatchObject({
        record_kind: "fact",
        state: "active",
        verification_status: "unverified",
        valid_from: null,
        valid_until: null,
        verified_at: null,
        ...(sourceVersion === 6
          ? { record_revision: 9, index_generation: 17 }
          : { record_revision: 4, index_generation: 1 }),
      });
      const history = revisions(db);
      expect(
        history.slice(0, 3).map((entry) => ({
          revision: entry.revision,
          snapshot: JSON.parse(entry.snapshot),
          changedAt: entry.changed_at,
          actor: entry.actor_id,
          reason: entry.reason,
          unknown: entry.legacy_metadata_unknown,
        })),
      ).toEqual([
        {
          revision: 1,
          snapshot: { title: "First title", content: "First content" },
          changedAt: originalTime,
          actor: null,
          reason: null,
          unknown: 1,
        },
        {
          revision: 2,
          snapshot: { title: "Second title", content: "Second content" },
          changedAt: "2025-04-01T00:00:00Z",
          actor: null,
          reason: null,
          unknown: 1,
        },
        {
          revision: 3,
          snapshot: { title: "Third title", content: "Third content" },
          changedAt: "2025-05-01T00:00:00Z",
          actor: null,
          reason: null,
          unknown: 1,
        },
      ]);
      const current = history[3];
      expect(JSON.parse(current?.snapshot ?? "null")).toEqual(row(db));
      expect(current).toMatchObject({
        changed_at: currentTime,
        legacy_metadata_unknown: 1,
        actor_id: null,
        reason: null,
      });
      expect(JSON.parse(revisions(db, 83)[0]?.snapshot ?? "null")).toEqual(row(db, 83));
      expect(db.query(`SELECT * FROM memory_evidence`).all()).toEqual([]);
      expect(db.query(`SELECT * FROM memory_evidence_links`).all()).toEqual([]);
      expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    });
  }
});

describe("retained generations and historical selection", () => {
  it("preserves existing v6 vector generations and legacy fingerprints", () => {
    const { db } = legacy(6);
    migrate(db);
    expect(
      db.query(`SELECT index_generation, legacy_model_fingerprint FROM memory_embeddings`).get(),
    ).toEqual({
      index_generation: 17,
      legacy_model_fingerprint: "pinned-model",
    });
  });

  it("retains live lexical results and excludes deleted records after pre-v6 upgrade", () => {
    const { db } = legacy(5);
    migrate(db);
    expect(db.query(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'current'`).all()).toEqual([
      { rowid: 41 },
    ]);
    expect(db.query(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'retained'`).all()).toEqual([]);
  });

  it("prefers the full current row when legacy history repeats its revision number", () => {
    const { db } = legacy(6);
    db.run(
      `INSERT INTO memory_versions VALUES (41, 9, 'Stale title', 'Incomplete stale snapshot', '${originalTime}')`,
    );
    migrate(db);
    expect(JSON.parse(revisions(db).at(-1)?.snapshot ?? "null")).toEqual(row(db));
    expect(revisions(db).at(-1)).toMatchObject({
      revision: 9,
      changed_at: currentTime,
      legacy_metadata_unknown: 1,
    });
  });
});

describe("verified migration backups", () => {
  it("includes committed WAL data in a verified restorable pre-migration backup", () => {
    const { db, path } = legacy(6);
    db.run(`CREATE VIRTUAL TABLE legacy_vec USING vec0(embedding float[2]);
      INSERT INTO legacy_vec(rowid, embedding) VALUES (41, '[1,0]');`);
    db.run(`PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);`);
    db.run(`UPDATE memories SET content = 'Committed only in WAL', record_revision = 10 WHERE id = 41`);
    expect(readFileSync(`${path}-wal`).byteLength).toBeGreaterThan(0);
    migrate(db);
    const backupPath = `${path}.pre-v${SCHEMA_VERSION}-from-v6.bak`;
    const metadata = JSON.parse(readFileSync(`${backupPath}.json`, "utf8"));
    expect(metadata).toMatchObject({
      fromSchema: 6,
      toSchema: SCHEMA_VERSION,
      integrity: "ok",
      foreignKeys: "ok",
    });
    const backup = open(metadata.backupPath);
    expect(version(backup)).toBe(6);
    expect(row(backup)).toMatchObject({
      id: 41,
      content: "Committed only in WAL",
      record_revision: 10,
      index_generation: 17,
    });
    expect(backup.query(`PRAGMA integrity_check`).all()).toEqual([{ integrity_check: "ok" }]);
    migrate(backup);
    expect(JSON.parse(revisions(backup).at(-1)?.snapshot ?? "null")).toEqual(row(db));
  });

  it("refuses migration when backup creation fails, without changing records or schema", () => {
    const { db } = legacy(6);
    const before = row(db);
    // SQLite refuses VACUUM INTO in a transaction, before any migration statement can execute.
    db.transaction(() => {
      expect(() => migrate(db)).toThrow("transaction");
    })();
    expect(version(db)).toBe(6);
    expect(row(db)).toEqual(before);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'memory_revisions'`).get()).toBeNull();
  });

  it("rejects a backup with foreign-key corruption before migration writes", () => {
    const { db, path } = legacy(6);
    db.run(`PRAGMA foreign_keys = OFF; UPDATE memories SET project_key = 'missing-project' WHERE id = 41;`);
    expect(() => migrate(db)).toThrow("foreign-key verification");
    expect(version(db)).toBe(6);
    expect(row(db).project_key).toBe("missing-project");
    expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}-from-v6.bak.json`)).toBe(false);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'memory_revisions'`).get()).toBeNull();
  });
});

describe("migration failure and reopen safety", () => {
  it("rolls back every schema change when a later migration statement fails", () => {
    const { db } = legacy(6);
    db.run(`CREATE TABLE memory_feedback (legacy_marker TEXT)`);
    const before = row(db);
    expect(() => migrate(db)).toThrow();
    expect(version(db)).toBe(6);
    expect(row(db)).toEqual(before);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'memory_revisions'`).get()).toBeNull();
  });

  it("reopens v7 without rewriting snapshots, schemas, generations or backups", () => {
    const { db, path } = legacy(6);
    migrate(db);
    const before = revisions(db);
    const schema = db.query(`PRAGMA schema_version`).get();
    const changes = db.query(`SELECT total_changes() AS count`).get();
    const files = readdirSync(join(path, "..")).sort();
    migrate(db);
    expect(revisions(db)).toEqual(before);
    expect(row(db)).toMatchObject({ record_revision: 9, index_generation: 17 });
    expect(db.query(`PRAGMA schema_version`).get()).toEqual(schema);
    expect(db.query(`SELECT total_changes() AS count`).get()).toEqual(changes);
    expect(readdirSync(join(path, "..")).sort()).toEqual(files);
  });

  it("rejects a future schema before backup or database writes", () => {
    const { db, path } = legacy(6);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const before = row(db);
    const schema = db.query(`PRAGMA schema_version`).get();
    const changes = db.query(`SELECT total_changes() AS count`).get();
    const files = readdirSync(join(path, "..")).sort();
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    expect(version(db)).toBe(SCHEMA_VERSION + 1);
    expect(row(db)).toEqual(before);
    expect(db.query(`PRAGMA schema_version`).get()).toEqual(schema);
    expect(db.query(`SELECT total_changes() AS count`).get()).toEqual(changes);
    expect(readdirSync(join(path, "..")).sort()).toEqual(files);
  });
});

describe("canonical revision history", () => {
  it("snapshots every column, preserving unknown extension metadata and attribution atomically", () => {
    const { db } = legacy(6);
    db.run(
      `ALTER TABLE memories ADD COLUMN extension_metadata TEXT; UPDATE memories SET extension_metadata = 'kept' WHERE id = 41`,
    );
    migrate(db);
    const prior = revisions(db).at(-1);
    db.transaction(() => {
      db.run(
        `INSERT INTO meta VALUES ('mutation_actor', 'owner-a'), ('mutation_reason', 'Verified correction')`,
      );
      db.run(`UPDATE memories SET title = 'Corrected', content = 'Corrected fact', record_revision = 10,
        record_kind = 'preference', state = 'active', verification_status = 'verified', valid_from = '${currentTime}',
        valid_until = '2027-01-01T00:00:00Z', verified_at = '${currentTime}', updated_at = '2026-03-01T00:00:00Z' WHERE id = 41`);
      db.run(`DELETE FROM meta WHERE key IN ('mutation_actor', 'mutation_reason')`);
    })();
    const next = revisions(db).at(-1);
    expect(next).toMatchObject({
      revision: 10,
      actor_id: "owner-a",
      reason: "Verified correction",
      legacy_metadata_unknown: 0,
      changed_at: "2026-03-01T00:00:00Z",
    });
    expect(JSON.parse(next?.snapshot ?? "null")).toEqual(row(db));
    expect(JSON.parse(next?.snapshot ?? "null").extension_metadata).toBe("kept");
    expect(revisions(db).find((entry) => entry.revision === 9)).toEqual(prior);
    db.run(
      `UPDATE memories SET shown_count = shown_count + 1, use_count = use_count + 1, last_used_at = '${currentTime}' WHERE id = 41`,
    );
    expect(revisions(db).at(-1)).toEqual(next);
    db.run(`UPDATE memories SET content = 'Next fact', record_revision = 11 WHERE id = 41`);
    expect(revisions(db).at(-1)).toMatchObject({
      revision: 11,
      actor_id: null,
      reason: null,
      legacy_metadata_unknown: 0,
    });
  });

  it("creates full initial snapshots and rolls back attempted history overwrite", () => {
    const db = open(newPath());
    migrate(db);
    db.run(`INSERT INTO memories (id, scope, type, title, content, content_hash, created_at, updated_at)
      VALUES (1, 'global', 'pattern', 'New fact', 'New content', 'hash', '${originalTime}', '${currentTime}')`);
    const first = revisions(db, 1)[0];
    expect(first).toMatchObject({ revision: 1, legacy_metadata_unknown: 0, actor_id: null, reason: null });
    expect(JSON.parse(first?.snapshot ?? "null")).toEqual(row(db, 1));
    db.run(`UPDATE memories SET content = 'Second fact', record_revision = 2 WHERE id = 1`);
    expect(() =>
      db.run(`UPDATE memories SET content = 'Overwrite first', record_revision = 1 WHERE id = 1`),
    ).toThrow();
    expect(row(db, 1)).toMatchObject({ content: "Second fact", record_revision: 2 });
    expect(revisions(db, 1)[0]).toEqual(first);
    expect(revisions(db, 1)[1]).toMatchObject({ revision: 2, legacy_metadata_unknown: 0 });
  });

  it("keeps evidence dependencies discoverable after record deletion", () => {
    const { db } = legacy(6);
    migrate(db);
    db.run(`INSERT INTO memory_evidence (evidence_id, source_kind, source_ref, stored_at, sensitivity, status, scope, project_key)
      VALUES ('source-evidence', 'memory', 'memory:41@9', '${currentTime}', 'private', 'resolved', 'project', 'project-a');
      INSERT INTO memory_evidence_links VALUES (83, 1, 'source-evidence', 'derived_from');
      INSERT INTO memory_relations VALUES (41, 9, 83, 1, 'derived_from', 'owner-a', '${currentTime}', 'verified');
      INSERT INTO review_jobs (id, source_watermark, purpose, policy_revision, state, created_at, updated_at)
        VALUES ('review-a', 'memory:41@9', 'memory_review', 1, 'queued', '${currentTime}', '${currentTime}');
      INSERT INTO review_job_sources VALUES ('review-a', 41, 9, 'source-evidence');
      INSERT INTO lifecycle_invalidations VALUES (41, 9, '${currentTime}');
      DELETE FROM memories WHERE id = 41;`);
    expect(
      db
        .query(`SELECT l.memory_id, l.revision FROM memory_evidence_links l JOIN memory_evidence e USING (evidence_id)
      WHERE e.source_ref = 'memory:41@9'`)
        .all(),
    ).toEqual([{ memory_id: 83, revision: 1 }]);
    expect(
      db
        .query(`SELECT to_id, to_revision FROM memory_relations WHERE from_id = 41 AND from_revision = 9`)
        .all(),
    ).toEqual([{ to_id: 83, to_revision: 1 }]);
    expect(
      db.query(`SELECT job_id FROM review_job_sources WHERE memory_id = 41 AND revision = 9`).all(),
    ).toEqual([{ job_id: "review-a" }]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});
