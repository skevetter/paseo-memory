import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertIndexWritable, selectIndexTarget } from "../service/model-indexes";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "../service/schema";
import { openDatabase } from "../service/sqlite";

const databases = new Set<Database>();
const directories: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const createdAt = "2024-05-01T00:00:00Z";
const updatedAt = "2026-09-01T00:00:00Z";
const observedAt = "2026-08-17T12:30:00Z";
const verifiedAt = "2026-08-01T00:00:00Z";
const walAt = "2026-10-01T00:00:00Z";

// Independent published v1.4.0 DDL, not a current migration with user_version changed afterward.
// Sources: https://github.com/skevetter/paseo-memory/blob/v1.4.0/service/schema.ts
// and https://github.com/skevetter/paseo-memory/blob/v1.4.0/service/vectors.ts.
const PUBLISHED_V7_SQL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE project_aliases (
    paseo_project_id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key), updated_at TEXT NOT NULL);
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_key TEXT REFERENCES projects(key), type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    topic_key TEXT, content_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    revision_count INTEGER NOT NULL DEFAULT 1, duplicate_count INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'agent', agent_id TEXT, provider TEXT, workspace_dir TEXT, branch TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT, deleted_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, merged_into INTEGER,
    shown_count INTEGER NOT NULL DEFAULT 0, opened_count INTEGER NOT NULL DEFAULT 0, kept_at TEXT, archived_at TEXT,
    index_generation INTEGER NOT NULL DEFAULT 1, record_revision INTEGER NOT NULL DEFAULT 1,
    record_kind TEXT NOT NULL DEFAULT 'fact', state TEXT NOT NULL DEFAULT 'active',
    verification_status TEXT NOT NULL DEFAULT 'unverified', valid_from TEXT, valid_until TEXT, verified_at TEXT,
    CHECK ((scope = 'global' AND project_key IS NULL) OR (scope = 'project' AND project_key IS NOT NULL)));
  CREATE UNIQUE INDEX ux_memories_topic ON memories(scope, ifnull(project_key, ''), topic_key)
    WHERE topic_key IS NOT NULL AND deleted_at IS NULL;
  CREATE INDEX ix_memories_scope ON memories(scope, project_key, deleted_at, updated_at DESC);
  CREATE TABLE memory_versions (
    memory_id INTEGER NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (memory_id, version));
  CREATE TABLE memory_embeddings (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, model TEXT NOT NULL, dims INTEGER NOT NULL,
    content_hash TEXT NOT NULL, embedded_at TEXT NOT NULL, index_generation INTEGER NOT NULL DEFAULT 0,
    model_fingerprint TEXT NOT NULL DEFAULT '', PRIMARY KEY (memory_id, model));
  CREATE TABLE vec_tables (
    model TEXT NOT NULL, dims INTEGER NOT NULL, table_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    PRIMARY KEY (model, dims));
  CREATE TABLE sessions (
    rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_key TEXT, agent_id TEXT NOT NULL,
    provider TEXT, title TEXT, workspace_dir TEXT, first_prompt TEXT, last_prompt TEXT, last_reply TEXT,
    files TEXT NOT NULL DEFAULT '[]', turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, ended_at TEXT, summary TEXT, outcomes TEXT, reviewed_at TEXT);
  CREATE INDEX ix_sessions_project ON sessions(project_key, updated_at DESC);
  CREATE TABLE agent_links (
    nonce TEXT PRIMARY KEY, agent_id TEXT, workspace_id TEXT, project_key TEXT, provider TEXT, title TEXT,
    created_at TEXT NOT NULL, linked_at TEXT, tools INTEGER NOT NULL DEFAULT 1);
  CREATE INDEX ix_agent_links_agent ON agent_links(agent_id);
  CREATE INDEX ix_agent_links_workspace ON agent_links(workspace_id, created_at DESC);
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX ix_audit_nonce ON audit_events(nonce, id);
  CREATE INDEX ix_audit_created ON audit_events(created_at);
  CREATE TABLE upkeep_dismissed (
    low_id INTEGER NOT NULL, high_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (low_id, high_id));
  CREATE TABLE review_windows (
    nonce TEXT PRIMARY KEY, window_id TEXT NOT NULL, agent_id TEXT NOT NULL, trigger TEXT NOT NULL,
    cap INTEGER NOT NULL, max_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, expires_at TEXT NOT NULL, closed_at TEXT);
  CREATE INDEX ix_review_windows_agent ON review_windows(agent_id, closed_at);
  CREATE TABLE review_ops (
    nonce TEXT NOT NULL, request_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('save', 'update', 'delete')),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'completed', 'released')),
    memory_id INTEGER, receipt TEXT, created_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY (nonce, request_key));
  CREATE TABLE memory_merges (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, relation TEXT NOT NULL,
    actor TEXT NOT NULL, source_snapshot TEXT NOT NULL, target_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL, undone_at TEXT);
  CREATE INDEX ix_memory_merges_source ON memory_merges(source_id, undone_at);
  CREATE TABLE memory_revisions (
    memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, changed_at TEXT NOT NULL,
    actor_id TEXT, reason TEXT, legacy_metadata_unknown INTEGER NOT NULL, PRIMARY KEY (memory_id, revision));
  CREATE TABLE memory_evidence (
    evidence_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, source_hash TEXT,
    observed_at TEXT, source_event_at TEXT, stored_at TEXT NOT NULL, actor_id TEXT, agent_id TEXT, bot_id TEXT,
    run_id TEXT, cycle_id TEXT, excerpt TEXT, sensitivity TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
    scope TEXT NOT NULL, project_key TEXT);
  CREATE INDEX ix_memory_evidence_source ON memory_evidence(source_ref);
  CREATE TABLE memory_evidence_links (
    memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, evidence_id TEXT NOT NULL, relationship TEXT NOT NULL,
    PRIMARY KEY (memory_id, revision, evidence_id, relationship));
  CREATE INDEX ix_memory_evidence_links_evidence ON memory_evidence_links(evidence_id);
  CREATE TABLE memory_relations (
    from_id INTEGER NOT NULL, from_revision INTEGER NOT NULL, to_id INTEGER NOT NULL, to_revision INTEGER NOT NULL,
    kind TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, verification_status TEXT NOT NULL,
    PRIMARY KEY (from_id, from_revision, to_id, to_revision, kind));
  CREATE INDEX ix_memory_relations_to ON memory_relations(to_id, to_revision);
  CREATE TABLE memory_mutations (
    principal_id TEXT NOT NULL, request_id TEXT NOT NULL, request_body_hash TEXT NOT NULL, operation TEXT NOT NULL,
    memory_id INTEGER NOT NULL, expected_revision INTEGER, resulting_revision INTEGER NOT NULL,
    result TEXT NOT NULL, created_at TEXT NOT NULL, actor_id TEXT, reason TEXT, PRIMARY KEY (principal_id, request_id));
  CREATE TABLE memory_feedback (
    producer_id TEXT NOT NULL, event_id TEXT NOT NULL, retrieval_id TEXT NOT NULL, memory_id INTEGER NOT NULL,
    revision INTEGER NOT NULL, run_id TEXT, cycle_id TEXT, signal TEXT NOT NULL, basis TEXT NOT NULL,
    evidence_refs TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (producer_id, event_id));
  CREATE TABLE review_jobs (
    id TEXT PRIMARY KEY, source_watermark TEXT NOT NULL, purpose TEXT NOT NULL, policy_revision INTEGER NOT NULL,
    state TEXT NOT NULL, lease_version INTEGER NOT NULL DEFAULT 0, input_fingerprint TEXT,
    reservations TEXT NOT NULL DEFAULT '{}', usage TEXT NOT NULL DEFAULT '{}', retry_deadline TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE review_job_sources (
    job_id TEXT NOT NULL, memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, evidence_id TEXT,
    PRIMARY KEY (job_id, memory_id, revision));
  CREATE INDEX ix_review_job_sources_memory ON review_job_sources(memory_id, revision);
  CREATE TABLE lifecycle_invalidations (
    memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (memory_id, revision));
  CREATE TABLE memory_tombstones (
    kind TEXT NOT NULL, identifier TEXT NOT NULL, forgotten_at TEXT NOT NULL, principal_id TEXT NOT NULL,
    PRIMARY KEY (kind, identifier));
  CREATE TABLE source_artifacts (
    source_ref TEXT PRIMARY KEY, content TEXT NOT NULL, source_hash TEXT NOT NULL, scope TEXT NOT NULL,
    project_key TEXT, allow_excerpt INTEGER NOT NULL, source_event_at TEXT, created_at TEXT NOT NULL);
`;

const PUBLISHED_SEARCH_SQL = `
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, content, topic_key, content = 'memories', content_rowid = 'id',
    tokenize = "porter unicode61 tokenchars '_-/'");
  CREATE TRIGGER memories_ai AFTER INSERT ON memories WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(rowid, title, content, topic_key) VALUES (new.id, new.title, new.content, new.topic_key);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories WHEN old.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      VALUES ('delete', old.id, old.title, old.content, old.topic_key);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      SELECT 'delete', old.id, old.title, old.content, old.topic_key WHERE old.deleted_at IS NULL;
    INSERT INTO memories_fts(rowid, title, content, topic_key)
      SELECT new.id, new.title, new.content, new.topic_key WHERE new.deleted_at IS NULL;
  END;
  CREATE VIRTUAL TABLE sessions_fts USING fts5(
    title, first_prompt, last_prompt, last_reply, summary, outcomes, content = 'sessions', content_rowid = 'rowid',
    tokenize = "porter unicode61 tokenchars '_-/'");
  CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, title, first_prompt, last_prompt, last_reply, summary, outcomes)
      VALUES (new.rowid, new.title, new.first_prompt, new.last_prompt, new.last_reply, new.summary, new.outcomes);
  END;
  CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, first_prompt, last_prompt, last_reply, summary, outcomes)
      VALUES ('delete', old.rowid, old.title, old.first_prompt, old.last_prompt, old.last_reply, old.summary, old.outcomes);
  END;
  CREATE TRIGGER sessions_au AFTER UPDATE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, first_prompt, last_prompt, last_reply, summary, outcomes)
      VALUES ('delete', old.rowid, old.title, old.first_prompt, old.last_prompt, old.last_reply, old.summary, old.outcomes);
    INSERT INTO sessions_fts(rowid, title, first_prompt, last_prompt, last_reply, summary, outcomes)
      VALUES (new.rowid, new.title, new.first_prompt, new.last_prompt, new.last_reply, new.summary, new.outcomes);
  END;
`;

const PUBLISHED_DATA_SQL = `
  INSERT INTO meta VALUES ('fixture_marker', 'published-v1.4.0');
  INSERT INTO projects VALUES
    ('project-a', 'Project A', '/fixture/a', '${createdAt}', '${updatedAt}'),
    ('project-b', 'Project B', '/fixture/b', '${createdAt}', '${updatedAt}');
  INSERT INTO project_aliases VALUES ('paseo-project-a', 'project-a', '${updatedAt}');
  INSERT INTO memories
    (id, scope, project_key, type, title, content, topic_key, content_hash, pinned, revision_count,
     duplicate_count, source, agent_id, provider, workspace_dir, branch, created_at, updated_at, last_seen_at,
     use_count, last_used_at, shown_count, opened_count, kept_at, index_generation, record_revision,
     record_kind, state, verification_status, valid_from, valid_until, verified_at)
    VALUES (41, 'project', 'project-a', 'decision', 'Deployment policy', 'Verified deployment policy',
      'deploy-policy', 'current-hash', 1, 9, 3, 'owner', 'agent-a', 'omp', '/fixture/a', 'main',
      '${createdAt}', '${updatedAt}', '${observedAt}', 18, '${observedAt}', 23, 7, '${createdAt}', 17, 9,
      'fact', 'active', 'verified', '${createdAt}', '2027-01-01T00:00:00Z', '${verifiedAt}');
  INSERT INTO memories
    (id, scope, type, title, content, content_hash, revision_count, duplicate_count, created_at, updated_at,
     deleted_at, use_count, last_used_at, merged_into, shown_count, opened_count, kept_at, archived_at,
     index_generation, record_revision, record_kind, state)
    VALUES (83, 'global', 'bugfix', 'Merged workaround', 'Retained merged history', 'merged-hash', 4, 2,
      '${createdAt}', '${updatedAt}', '${updatedAt}', 9, '${observedAt}', 41, 12, 5, '${createdAt}',
      '${updatedAt}', 8, 4, 'fact', 'superseded');
  INSERT INTO memories
    (id, scope, project_key, type, title, content, content_hash, revision_count, created_at, updated_at,
     index_generation, record_revision, record_kind, state)
    VALUES (120, 'project', 'project-b', 'preference', 'Unapproved preference', 'Candidate preference',
      'candidate-hash', 3, '${createdAt}', '${updatedAt}', 5, 3, 'preference', 'candidate');
  INSERT INTO memory_versions VALUES
    (41, 1, 'Original policy', 'Original deployment policy', '${createdAt}'),
    (41, 2, 'Earlier policy', 'Earlier deployment policy', '2025-01-01T00:00:00Z'),
    (83, 1, 'Original workaround', 'Earlier workaround', '${createdAt}');
  INSERT INTO sessions
    (rowid, id, project_key, agent_id, provider, title, workspace_dir, first_prompt, last_prompt, last_reply,
     files, turns, started_at, updated_at, ended_at, summary, outcomes, reviewed_at)
    VALUES (11, 'session-a', 'project-a', 'agent-a', 'omp', 'Deployment task', '/fixture/a', 'Inspect deployment',
      'Verify deployment', 'Deployment verified', '["deploy.ts"]', 3, '${createdAt}', '${updatedAt}',
      '${updatedAt}', 'Deployment episode', 'Verified artifact', '${updatedAt}');
  INSERT INTO agent_links VALUES
    ('nonce-a', 'agent-a', 'workspace-a', 'project-a', 'omp', 'Deployment task', '${createdAt}', '${updatedAt}', 1);
  INSERT INTO audit_events VALUES
    (3, 'nonce-a', 'context', '{"retrieval":{"retrievalId":"retrieval-a"}}', '${updatedAt}'),
    (7, 'nonce-a', 'legacy', 'Historical unstructured audit detail', '${createdAt}');
  INSERT INTO upkeep_dismissed VALUES (41, 120, '${updatedAt}');
  INSERT INTO review_windows VALUES
    ('nonce-a', 'window-a', 'agent-a', 'idle', 3, 8, 2, '${createdAt}', '${updatedAt}', '${updatedAt}');
  INSERT INTO review_ops VALUES
    ('nonce-a', 'request-a', 'update', 'committed', 41, '{"revision":9}', '${createdAt}', '${updatedAt}');
  INSERT INTO memory_merges VALUES
    (2, 83, 41, 'duplicate', 'owner', '{"id":83,"revision":3}', '{"id":41,"revision":8}', '${updatedAt}', NULL);
  INSERT INTO memory_evidence VALUES
    ('evidence-a', 'artifact', 'artifact:deployment-a', 'artifact-hash', '${observedAt}', '${createdAt}',
      '${updatedAt}', 'owner', 'agent-a', NULL, 'run-a', 'cycle-a', 'Approved deployment', 'internal',
      'verified', NULL, 'project', 'project-a');
  INSERT INTO memory_evidence_links VALUES (41, 9, 'evidence-a', 'supports');
  INSERT INTO memory_relations VALUES (120, 3, 41, 9, 'derived_from', 'agent-a', '${updatedAt}', 'unverified');
  INSERT INTO memory_mutations VALUES
    ('owner', 'mutation-a', 'body-hash', 'update', 41, 8, 9, '{"revision":9}', '${updatedAt}', 'owner', 'Approved');
  INSERT INTO memory_feedback VALUES
    ('producer-a', 'feedback-a', 'retrieval-a', 41, 9, 'run-a', 'cycle-a', 'helpful', 'validator',
      '["evidence-a"]', '${updatedAt}');
  INSERT INTO review_jobs VALUES
    ('job-a', 'watermark-a', 'memory_review', 4, 'completed', 2, 'input-a', '{"attempts":2}',
      '{"inputTokens":23}', NULL, '${createdAt}', '${updatedAt}');
  INSERT INTO review_job_sources VALUES ('job-a', 41, 9, 'evidence-a');
  INSERT INTO lifecycle_invalidations VALUES (120, 3, '${updatedAt}');
  INSERT INTO memory_tombstones VALUES ('memory', '999', '${updatedAt}', 'owner');
  INSERT INTO source_artifacts VALUES
    ('artifact:deployment-a', 'Approved deployment', 'artifact-hash', 'project', 'project-a', 1,
      '${createdAt}', '${updatedAt}');
  CREATE VIRTUAL TABLE vec_legacy_model_2 USING vec0(memory_id INTEGER PRIMARY KEY,
    scope_key TEXT PARTITION KEY, embedding FLOAT[2] distance_metric=cosine);
  CREATE VIRTUAL TABLE vec_legacy_model_3 USING vec0(memory_id INTEGER PRIMARY KEY,
    scope_key TEXT PARTITION KEY, embedding FLOAT[3] distance_metric=cosine);
  CREATE VIRTUAL TABLE vec_unused_model_4 USING vec0(memory_id INTEGER PRIMARY KEY,
    scope_key TEXT PARTITION KEY, embedding FLOAT[4] distance_metric=cosine);
  INSERT INTO vec_tables VALUES
    ('legacy/model', 2, 'vec_legacy_model_2', '${createdAt}'),
    ('legacy/model', 3, 'vec_legacy_model_3', '${updatedAt}'),
    ('unused/model', 4, 'vec_unused_model_4', '${createdAt}');
  INSERT INTO vec_legacy_model_2 VALUES
    (41, 'project:0123456789abcdef', x'0000803f00000000'), (83, 'global', x'0000003f000080bf');
  INSERT INTO vec_legacy_model_3 VALUES (120, 'project:fedcba9876543210', x'000000000000803f00000000');
  INSERT INTO memory_embeddings VALUES
    (41, 'legacy/model', 2, 'current-hash', '${updatedAt}', 17, 'old-model-fingerprint'),
    (83, 'legacy/model', 2, 'merged-hash', '${createdAt}', 8, ''),
    (120, 'legacy/model', 3, 'candidate-hash', '${updatedAt}', 5, 'old-three-dimensional-fingerprint'),
    (41, 'metadata-only', 2, 'older-hash', '${createdAt}', 0, 'unverified-old-fingerprint');
`;

const PRESERVED_TABLES = [
  "projects",
  "project_aliases",
  "memory_versions",
  "sessions",
  "agent_links",
  "audit_events",
  "upkeep_dismissed",
  "review_windows",
  "review_ops",
  "memory_merges",
  "memory_revisions",
  "memory_evidence",
  "memory_evidence_links",
  "memory_relations",
  "memory_mutations",
  "review_jobs",
  "review_job_sources",
  "lifecycle_invalidations",
  "memory_tombstones",
  "source_artifacts",
] as const;
const V7_TABLES = [
  ...PRESERVED_TABLES,
  "memories",
  "memory_feedback",
  "memory_embeddings",
  "vec_tables",
  "meta",
] as const;
const V8_TABLES = [
  ...PRESERVED_TABLES,
  "memories",
  "memory_feedback",
  "memory_embeddings",
  "embedding_indexes",
  "model_usage",
  "meta",
] as const;
const VECTOR_TABLES = ["vec_legacy_model_2", "vec_legacy_model_3", "vec_unused_model_4"] as const;

type RowsByTable = Record<string, Record<string, unknown>[]>;

interface RevisionSnapshot {
  snapshot: string;
  actor_id: string | null;
  reason: string | null;
  legacy_metadata_unknown: number;
}

// Published v7 columns; v8 adds nullable columns, asserted separately.
const RETAINED_COLUMNS: Record<string, string> = {
  memory_evidence:
    "evidence_id, source_kind, source_ref, source_hash, observed_at, source_event_at, stored_at, actor_id, agent_id, bot_id, run_id, cycle_id, excerpt, sensitivity, status, reason, scope, project_key",
  source_artifacts:
    "source_ref, content, source_hash, scope, project_key, allow_excerpt, source_event_at, created_at",
};

function readTables(db: Database, tables: readonly string[]): RowsByTable {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .query<Record<string, unknown>, []>(
          `SELECT ${RETAINED_COLUMNS[table] ?? "*"} FROM ${table} ORDER BY rowid`,
        )
        .all(),
    ]),
  );
}

function readVectors(db: Database): RowsByTable {
  return Object.fromEntries(
    VECTOR_TABLES.map((table) => [
      table,
      db
        .query<Record<string, unknown>, []>(
          `SELECT memory_id, scope_key, hex(embedding) AS vector FROM ${table} ORDER BY memory_id`,
        )
        .all(),
    ]),
  );
}

function open(path: string): Database {
  const { db } = openDatabase(path);
  databases.add(db);
  return db;
}

function publishedV7(): { db: Database; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "pm-v8-"));
  directories.push(directory);
  const path = join(directory, "memory.db");
  const db = open(path);
  db.run(PUBLISHED_V7_SQL);
  db.run(PUBLISHED_SEARCH_SQL);
  db.run(PUBLISHED_DATA_SQL);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(memories)").all();
  const currentFields = columns.map(({ name }) => `'${name}', m."${name}"`).join(", ");
  const newFields = columns.map(({ name }) => `'${name}', new."${name}"`).join(", ");
  db.run(`
    INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, legacy_metadata_unknown)
      SELECT memory_id, version, json_object('title', title, 'content', content), created_at, 1 FROM memory_versions;
    INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
      SELECT id, record_revision, json_object(${currentFields}), updated_at,
        CASE WHEN id=83 THEN NULL ELSE 'owner' END, CASE WHEN id=83 THEN NULL ELSE 'Approved v7 revision' END,
        CASE WHEN id=83 THEN 1 ELSE 0 END FROM memories m;
    CREATE TRIGGER memory_revision_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        VALUES (new.id, new.record_revision, json_object(${newFields}), new.updated_at,
          (SELECT value FROM meta WHERE key='mutation_actor'), (SELECT value FROM meta WHERE key='mutation_reason'), 0);
    END;
    CREATE TRIGGER memory_revision_au AFTER UPDATE ON memories WHEN new.record_revision != old.record_revision BEGIN
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        VALUES (new.id, new.record_revision, json_object(${newFields}), new.updated_at,
          (SELECT value FROM meta WHERE key='mutation_actor'), (SELECT value FROM meta WHERE key='mutation_reason'), 0);
    END;
    PRAGMA user_version = 7;
  `);
  return { db, path };
}

it("preserves published v7 records, timestamps, counters and immutable canonical history", () => {
  const { db } = publishedV7();
  const before = readTables(db, V7_TABLES);
  migrate(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  expect(readTables(db, PRESERVED_TABLES)).toEqual(
    Object.fromEntries(
      Object.entries(before).filter(([name]) => PRESERVED_TABLES.some((table) => table === name)),
    ),
  );
  expect(db.query("SELECT bot_id FROM source_artifacts").all()).toEqual([{ bot_id: null }]);
  expect(db.query("SELECT namespace_bot_id FROM memory_evidence").all()).toEqual([
    { namespace_bot_id: null },
  ]);
  const records = db.query<Record<string, unknown>, []>("SELECT * FROM memories ORDER BY id").all();
  expect(records.map((record) => record.id)).toEqual([41, 83, 120]);
  for (const record of records) {
    const prior = before.memories?.find((candidate) => candidate.id === record.id);
    expect(record).toMatchObject({
      ...prior,
      last_retrieved_at: null,
      application_count: 0,
      validated_helpful_count: 0,
      validated_harmful_count: 0,
    });
  }
  expect(records[0]).toMatchObject({
    record_revision: 9,
    index_generation: 17,
    verified_at: verifiedAt,
    last_used_at: observedAt,
    revision_count: 9,
    duplicate_count: 3,
    use_count: 18,
    shown_count: 23,
    opened_count: 7,
  });
  expect(db.query("SELECT * FROM memory_feedback").all()).toMatchObject([
    {
      ...before.memory_feedback?.[0],
      validated: 0,
      verifier_id: null,
      verifier_version: null,
      support_valid_until: null,
    },
  ]);
  expect(db.query("SELECT * FROM model_usage").all()).toEqual([]);
  expect(db.query("SELECT value FROM meta WHERE key='fixture_marker'").get()).toEqual({
    value: "published-v1.4.0",
  });
  expect(db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'deployment'").all()).toEqual([
    { rowid: 41 },
  ]);
  expect(db.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'episode'").all()).toEqual([
    { rowid: 11 },
  ]);
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("retains all legacy vector bytes and metadata without inventing pinned identities or write authority", () => {
  const { db } = publishedV7();
  const before = db
    .query<Record<string, unknown>, []>("SELECT * FROM memory_embeddings ORDER BY memory_id, model, dims")
    .all();
  const vectors = readVectors(db);
  migrate(db);
  expect(readVectors(db)).toEqual(vectors);
  const expected = before.map((row) => ({
    memory_id: row.memory_id,
    index_fingerprint: `legacy:${row.model}:${row.dims}`,
    content_hash: row.content_hash,
    index_generation: row.index_generation,
    embedded_at: row.embedded_at,
    legacy_model_fingerprint: row.model_fingerprint,
  }));
  expect(db.query("SELECT * FROM memory_embeddings ORDER BY memory_id, index_fingerprint").all()).toEqual(
    expected,
  );
  const indexes = db
    .query<Record<string, unknown>, []>(
      "SELECT fingerprint, model, dims, table_name, identity_json, state, created_at, ready_at, retired_at FROM embedding_indexes ORDER BY fingerprint",
    )
    .all();
  expect(
    indexes.map((index) => [index.fingerprint, index.model, index.dims, index.table_name, index.created_at]),
  ).toEqual([
    ["legacy:legacy/model:2", "legacy/model", 2, "vec_legacy_model_2", createdAt],
    ["legacy:legacy/model:3", "legacy/model", 3, "vec_legacy_model_3", updatedAt],
    ["legacy:metadata-only:2", "metadata-only", 2, null, null],
    ["legacy:unused/model:4", "unused/model", 4, "vec_unused_model_4", createdAt],
  ]);
  for (const index of indexes) {
    expect(index).toMatchObject({
      identity_json: null,
      state: "legacy",
      ready_at: null,
      retired_at: null,
    });
    const fingerprint = String(index.fingerprint);
    selectIndexTarget(db, fingerprint);
    expect(() => assertIndexWritable(db, fingerprint)).toThrow();
  }
  expect(readVectors(db)).toEqual(vectors);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='vec_tables'").get()).toBeNull();
});

it("rebuilds revision triggers for new v8 metrics without rewriting published snapshots", () => {
  const { db } = publishedV7();
  const prior = db
    .query<Record<string, unknown>, []>("SELECT * FROM memory_revisions ORDER BY memory_id, revision")
    .all();
  migrate(db);
  db.run(`
    INSERT INTO meta VALUES ('mutation_actor', 'owner-v8'), ('mutation_reason', 'Measured resource fields');
    UPDATE memories SET content='New accepted policy', record_revision=10, index_generation=18,
      updated_at='${walAt}', last_retrieved_at='${walAt}', application_count=4,
      validated_helpful_count=2, validated_harmful_count=1 WHERE id=41;
    INSERT INTO memories (id,scope,type,title,content,content_hash,created_at,updated_at,
      last_retrieved_at,application_count,validated_helpful_count,validated_harmful_count)
      VALUES (140,'global','note','New v8 fact','New fact','new-hash','${walAt}','${walAt}',
        '${walAt}',3,1,2);
  `);
  expect(
    db
      .query(
        "SELECT * FROM memory_revisions WHERE NOT (memory_id=41 AND revision=10) AND memory_id!=140 ORDER BY memory_id,revision",
      )
      .all(),
  ).toEqual(prior);
  for (const id of [41, 140]) {
    const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM memories WHERE id=?").get(id);
    const revision = db
      .query<RevisionSnapshot, [number]>(
        "SELECT snapshot,actor_id,reason,legacy_metadata_unknown FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(id);
    expect(JSON.parse(revision?.snapshot ?? "null")).toEqual(row);
    expect(revision).toMatchObject({
      actor_id: "owner-v8",
      reason: "Measured resource fields",
      legacy_metadata_unknown: 0,
    });
  }
});

const BackupMetadataSchema = z.object({
  backupPath: z.string(),
  fromSchema: z.literal(7),
  toSchema: z.number().int(),
  integrity: z.literal("ok"),
  foreignKeys: z.literal("ok"),
  createdAt: z.iso.datetime(),
});

it("verifies and restores a published v7 backup containing committed WAL records and vec0 pages", () => {
  const { db, path } = publishedV7();
  db.run(`PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);
    UPDATE memories SET content='Committed only in WAL',content_hash='wal-hash',record_revision=10,
      index_generation=18,updated_at='${walAt}' WHERE id=41;
    DELETE FROM vec_legacy_model_2 WHERE memory_id=41;
    INSERT INTO vec_legacy_model_2 VALUES (41,'project:0123456789abcdef',x'0000803e0000403f');
    UPDATE memory_embeddings SET content_hash='wal-hash',index_generation=18,embedded_at='${walAt}'
      WHERE memory_id=41 AND model='legacy/model';`);
  expect(readFileSync(`${path}-wal`).byteLength).toBeGreaterThan(32);
  const before = readTables(db, V7_TABLES);
  const vectors = readVectors(db);
  migrate(db);
  const backupPath = `${path}.pre-v${SCHEMA_VERSION}-from-v7.bak`;
  const metadata = BackupMetadataSchema.parse(JSON.parse(readFileSync(`${backupPath}.json`, "utf8")));
  expect(metadata).toMatchObject({ fromSchema: 7, toSchema: SCHEMA_VERSION });
  const restoredPath = join(dirname(path), "restored.db");
  copyFileSync(metadata.backupPath, restoredPath);
  const restored = open(restoredPath);
  expect(restored.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  expect(readTables(restored, V7_TABLES)).toEqual(before);
  expect(readVectors(restored)).toEqual(vectors);
  expect(restored.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    restored
      .query(`SELECT memory_id FROM vec_legacy_model_2
        WHERE embedding MATCH '[0.25,0.75]' AND k=1 AND scope_key='project:0123456789abcdef'`)
      .all(),
  ).toEqual([{ memory_id: 41 }]);
  migrate(restored);
  expect(
    readTables(
      restored,
      V8_TABLES.filter((table) => table !== "meta"),
    ),
  ).toEqual(
    readTables(
      db,
      V8_TABLES.filter((table) => table !== "meta"),
    ),
  );
  expect(readVectors(restored)).toEqual(vectors);
});

it("reopens schema v8 without backup creation, epoch refresh, revision writes or schema changes", () => {
  const { db, path } = publishedV7();
  migrate(db);
  db.close();
  databases.delete(db);
  const reopened = open(path);
  const before = readTables(reopened, V8_TABLES);
  const vectors = readVectors(reopened);
  const schema = reopened.query("PRAGMA schema_version").get();
  const changes = reopened.query("SELECT total_changes() AS count").get();
  const files = readdirSync(dirname(path)).sort();
  const metadataFiles = files.filter((name) => name.endsWith(".json"));
  const metadata = metadataFiles.map((name) => readFileSync(join(dirname(path), name), "utf8"));
  migrate(reopened);
  expect(readTables(reopened, V8_TABLES)).toEqual(before);
  expect(readVectors(reopened)).toEqual(vectors);
  expect(reopened.query("PRAGMA schema_version").get()).toEqual(schema);
  expect(reopened.query("SELECT total_changes() AS count").get()).toEqual(changes);
  expect(readdirSync(dirname(path)).sort()).toEqual(files);
  expect(metadataFiles.map((name) => readFileSync(join(dirname(path), name), "utf8"))).toEqual(metadata);
});

it("rolls back a late v8 table collision including vectors, old triggers and all dropped v7 metadata", () => {
  const { db } = publishedV7();
  db.run(
    "CREATE TABLE model_usage (legacy_marker TEXT); INSERT INTO model_usage VALUES ('preserve collision');",
  );
  const tables = [...V7_TABLES, "model_usage"];
  const before = readTables(db, tables);
  const vectors = readVectors(db);
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  expect(() => migrate(db)).toThrow();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  expect(readTables(db, tables)).toEqual(before);
  expect(readVectors(db)).toEqual(vectors);
  expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(
    schema,
  );
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.run(
    `UPDATE memories SET content='V7 remains usable',record_revision=10,updated_at='${walAt}' WHERE id=41;`,
  );
  const restoredRevision = db
    .query<{ snapshot: string }, []>(
      "SELECT snapshot FROM memory_revisions WHERE memory_id=41 AND revision=10",
    )
    .get();
  expect(JSON.parse(restoredRevision?.snapshot ?? "null")).toEqual(
    db.query("SELECT * FROM memories WHERE id=41").get(),
  );
});

it("rejects a newer opaque schema before backup creation or any database writes", () => {
  const { db, path } = publishedV7();
  db.run(`ALTER TABLE memories ADD COLUMN future_marker TEXT;
    UPDATE memories SET future_marker='preserve newer state' WHERE id=41;
    CREATE TABLE future_resources (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO future_resources VALUES (73,'uninterpreted future data');
    PRAGMA user_version=${SCHEMA_VERSION + 1};`);
  const tables = [...V7_TABLES, "future_resources"];
  const before = readTables(db, tables);
  const vectors = readVectors(db);
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const changes = db.query("SELECT total_changes() AS count").get();
  const files = readdirSync(dirname(path)).sort();
  const mainBytes = readFileSync(path);
  const walBytes = readFileSync(`${path}-wal`);
  expect(() => migrate(db)).toThrow(SchemaTooNewError);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION + 1 });
  expect(readTables(db, tables)).toEqual(before);
  expect(readVectors(db)).toEqual(vectors);
  expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(
    schema,
  );
  expect(db.query("SELECT total_changes() AS count").get()).toEqual(changes);
  expect(readdirSync(dirname(path)).sort()).toEqual(files);
  expect(readFileSync(path)).toEqual(mainBytes);
  expect(readFileSync(`${path}-wal`)).toEqual(walBytes);
});
