import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, statfsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { migrateBridgeSchema } from "./bridge-schema";
import { FatalError } from "./sqlite";

export const SCHEMA_VERSION = 9;

export class SchemaTooNewError extends FatalError {
  constructor(found: number, supported: number) {
    super(
      `The memory database uses schema v${found}, but this plugin supports up to schema v${supported}. ` +
        "Update paseo-memory to open it. The database was not modified.",
    );
  }
}

export function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version ?? 0;
  if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current, SCHEMA_VERSION);
  if (current === SCHEMA_VERSION) return;
  backupBeforeMigration(db, current);
  const foreignKeys = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0;
  // Disable actions before BEGIN: DROP of the replaced parent must not cascade into retained evidence/indexes.
  db.run("PRAGMA foreign_keys=OFF");
  try {
    if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 0)
      throw new FatalError(
        "A memory migration requires an outermost transaction; the database was not modified.",
      );
    db.transaction(() => {
      if (current < 6) migratePreV6(db, current);
      if (current < 7) migrateLifecycle(db);
      if (current < 8) migrateResources(db, current);
      migrateBridgeSchema(db);
      createRevisionTriggers(db);
      if (current < 7) importLegacyRevisions(db);
      if (db.query(`PRAGMA foreign_key_check`).all().length !== 0)
        throw new FatalError(
          "Memory migration failed foreign-key verification; the migration was rolled back.",
        );
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  } finally {
    db.run(`PRAGMA foreign_keys=${foreignKeys === 1 ? 1 : 0}`);
  }
}

function migratePreV6(db: Database, from: number): void {
  if (from === 1) dropV1Vectors(db);
  db.run(SCHEMA_SQL);
  addColumns(db, "memories", V3_MEMORY_COLUMNS);
  db.run(V3_SQL);
  addColumns(db, "memories", V4_MEMORY_COLUMNS);
  addColumns(db, "sessions", V4_SESSION_COLUMNS);
  addColumns(db, "agent_links", [["tools", "INTEGER NOT NULL DEFAULT 1"]]);
  db.run(V4_SQL);
  db.run(V5_SQL);
  addColumns(db, "memories", V6_MEMORY_COLUMNS);
  addColumns(db, "memory_embeddings", V6_EMBEDDING_COLUMNS);
  db.run(V6_SQL);
}

function migrateLifecycle(db: Database): void {
  db.run(REVIEW_SQL);
  addColumns(db, "memories", V7_MEMORY_COLUMNS);
  db.run(`UPDATE memories SET state=CASE WHEN merged_into IS NOT NULL THEN 'superseded'
    WHEN deleted_at IS NOT NULL OR archived_at IS NOT NULL THEN 'archived' ELSE 'active' END,
    record_kind=CASE WHEN type='preference' THEN 'preference' ELSE 'fact' END`);
  db.run(V7_SQL);
}

function migrateResources(db: Database, from: number): void {
  if (from >= 7) db.run("DROP TRIGGER memory_revision_ai; DROP TRIGGER memory_revision_au;");
  addColumns(db, "memories", [
    ["last_retrieved_at", "TEXT"],
    ["application_count", "INTEGER NOT NULL DEFAULT 0"],
    ["validated_helpful_count", "INTEGER NOT NULL DEFAULT 0"],
    ["validated_harmful_count", "INTEGER NOT NULL DEFAULT 0"],
  ]);
  addColumns(db, "memory_feedback", [
    ["validated", "INTEGER NOT NULL DEFAULT 0"],
    ["verifier_id", "TEXT"],
    ["verifier_version", "TEXT"],
    ["support_valid_until", "TEXT"],
  ]);
  db.run(V8_SQL);
  createRevisionTriggers(db);
}

// VACUUM INTO writes a consistent snapshot including pages still in the WAL, which a plain file copy would miss.
function backupBeforeMigration(db: Database, from: number): void {
  const file = db
    .query<{ file: string }, []>(`SELECT file FROM pragma_database_list WHERE name = 'main'`)
    .get()?.file;
  if (!file) return;
  const pages = db.query<{ page_count: number }, []>(`PRAGMA page_count`).get()?.page_count ?? 0;
  if (pages === 0) return;
  const pageSize = db.query<{ page_size: number }, []>(`PRAGMA page_size`).get()?.page_size ?? 4096;
  const space = statfsSync(dirname(file), { bigint: true });
  const required = BigInt(pages) * BigInt(pageSize) * 2n + 1048576n;
  if (space.bavail * space.bsize < required) {
    throw new FatalError(
      "Insufficient disk space for a verified memory backup and migration; the database was not modified.",
    );
  }
  const base = `${file}.pre-v${SCHEMA_VERSION}-from-v${from}.bak`;
  const target = existsSync(base) ? `${base}.${randomUUID()}` : base;
  writeFileSync(target, "", { flag: "wx", mode: 0o600 });
  db.query(`VACUUM INTO ?`).run(target);
  const backup = new Database(target, { readonly: true });
  try {
    verifyBackup(backup, from, target);
  } finally {
    backup.close();
  }
}

function verifyBackup(backup: Database, from: number, target: string): void {
  backup.loadExtension(getLoadablePath());
  const integrity = backup.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new FatalError(`Memory backup failed integrity verification: ${target}; migration refused.`);
  }
  const version = backup.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version;
  if (version !== from || backup.query(`PRAGMA foreign_key_check`).all().length !== 0) {
    throw new FatalError(
      `Memory backup failed schema or foreign-key verification: ${target}; migration refused.`,
    );
  }
  writeFileSync(
    `${target}.json`,
    JSON.stringify({
      backupPath: target,
      fromSchema: from,
      toSchema: SCHEMA_VERSION,
      integrity: "ok",
      foreignKeys: "ok",
      createdAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
}

const V7_MEMORY_COLUMNS: [string, string][] = [
  ["record_kind", "TEXT NOT NULL DEFAULT 'fact'"],
  ["state", "TEXT NOT NULL DEFAULT 'active'"],
  ["verification_status", "TEXT NOT NULL DEFAULT 'unverified'"],
  ["valid_from", "TEXT"],
  ["valid_until", "TEXT"],
  ["verified_at", "TEXT"],
];

function snapshotSql(db: Database, prefix: string): string {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(memories)").all();
  return `json_object(${columns.map(({ name }) => `'${name.replaceAll("'", "''")}', ${prefix}."${name.replaceAll('"', '""')}"`).join(", ")})`;
}

function importLegacyRevisions(db: Database): void {
  db.run(`
    INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, legacy_metadata_unknown)
      SELECT id, record_revision, ${snapshotSql(db, "memories")}, updated_at, 1 FROM memories;
    INSERT OR IGNORE INTO memory_revisions (memory_id, revision, snapshot, changed_at, legacy_metadata_unknown)
      SELECT memory_id, version, json_object('title', title, 'content', content), created_at, 1 FROM memory_versions;
  `);
}

function createRevisionTriggers(db: Database): void {
  const snapshot = snapshotSql(db, "new");
  const updateSnapshot = snapshotSql(db, "m");
  db.run(`
    CREATE TRIGGER memory_revision_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        VALUES (new.id, new.record_revision, ${snapshot}, new.updated_at,
          (SELECT value FROM meta WHERE key = 'mutation_actor'), (SELECT value FROM meta WHERE key = 'mutation_reason'), 0);
    END;
    CREATE TRIGGER memory_revision_au AFTER UPDATE ON memories WHEN new.record_revision != old.record_revision BEGIN
      UPDATE memories SET application_count=0,validated_helpful_count=0,validated_harmful_count=0
        WHERE id=new.id AND (application_count!=0 OR validated_helpful_count!=0 OR validated_harmful_count!=0);
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        SELECT new.id,new.record_revision,${updateSnapshot},new.updated_at,
          (SELECT value FROM meta WHERE key='mutation_actor'),(SELECT value FROM meta WHERE key='mutation_reason'),0
        FROM memories m WHERE m.id=new.id;
    END;
  `);
}

const V8_SQL = `
  CREATE TABLE embedding_indexes (
    fingerprint TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE, model TEXT NOT NULL, dims INTEGER NOT NULL,
    table_name TEXT UNIQUE, identity_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('building','ready','retired','legacy')),
    created_at TEXT, ready_at TEXT, retired_at TEXT);
  INSERT INTO embedding_indexes (fingerprint,generation,model,dims,table_name,state,created_at)
    SELECT 'legacy:' || model || ':' || dims,row_number() OVER (ORDER BY model,dims),model,dims,table_name,'legacy',created_at
    FROM (
      SELECT model,dims,table_name,created_at FROM vec_tables
      UNION ALL SELECT e.model,e.dims,NULL,NULL FROM memory_embeddings e
        WHERE NOT EXISTS (SELECT 1 FROM vec_tables v WHERE v.model=e.model AND v.dims=e.dims)
        GROUP BY e.model,e.dims);
  INSERT INTO meta(key,value)
    SELECT 'embedding_index_generation',CAST(coalesce(max(generation),0) AS TEXT) FROM embedding_indexes;
  ALTER TABLE memory_embeddings RENAME TO memory_embeddings_v7;
  CREATE TABLE memory_embeddings (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    index_fingerprint TEXT NOT NULL REFERENCES embedding_indexes(fingerprint) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,index_generation INTEGER NOT NULL,embedded_at TEXT NOT NULL,
    legacy_model_fingerprint TEXT,PRIMARY KEY (memory_id,index_fingerprint));
  INSERT INTO memory_embeddings
    SELECT memory_id,'legacy:' || model || ':' || dims,content_hash,index_generation,embedded_at,model_fingerprint
    FROM memory_embeddings_v7;
  DROP TABLE memory_embeddings_v7;
  DROP TABLE vec_tables;
  CREATE INDEX ix_memory_embeddings_index ON memory_embeddings(index_fingerprint,memory_id);
  CREATE INDEX ix_memory_feedback_ref ON memory_feedback(memory_id,revision,signal,validated);
  CREATE INDEX ix_memory_feedback_expiry ON memory_feedback(support_valid_until)
    WHERE validated=1 AND support_valid_until IS NOT NULL;
  CREATE INDEX ix_audit_retrieval ON audit_events (
    json_extract(CASE WHEN json_valid(detail) THEN detail ELSE '{}' END,'$.retrieval.retrievalId'));
  CREATE TABLE model_usage (
    producer_id TEXT NOT NULL,event_id TEXT NOT NULL,attempt_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (typeof(source_sequence)='integer' AND source_sequence BETWEEN 0 AND 9007199254740991),
    stage TEXT NOT NULL,status TEXT NOT NULL,provenance TEXT NOT NULL,model TEXT,
    input_tokens INTEGER,output_tokens INTEGER,cost_amount REAL,currency TEXT,
    source_event_id TEXT,retrieval_id TEXT,job_id TEXT,estimator TEXT,duration_ms REAL,created_at TEXT NOT NULL,
    PRIMARY KEY (producer_id,event_id),UNIQUE (producer_id,attempt_id,stage,source_sequence));
  CREATE INDEX ix_model_usage_attempt ON model_usage(stage,attempt_id,created_at);
  CREATE UNIQUE INDEX ix_model_usage_provider_source ON model_usage(producer_id,source_event_id)
    WHERE provenance='provider_observed' AND source_event_id IS NOT NULL;
  INSERT INTO meta(key,value) VALUES ('resource_observation_epoch',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

const V7_SQL = `
  CREATE TABLE memory_revisions (
    memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, changed_at TEXT NOT NULL,
    actor_id TEXT, reason TEXT, legacy_metadata_unknown INTEGER NOT NULL,
    PRIMARY KEY (memory_id, revision));
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

const V6_MEMORY_COLUMNS: [string, string][] = [
  ["index_generation", "INTEGER NOT NULL DEFAULT 1"],
  ["record_revision", "INTEGER NOT NULL DEFAULT 1"],
];

// Existing vectors predate generation tracking, so they cannot prove an earlier index race did not happen.
const V6_EMBEDDING_COLUMNS: [string, string][] = [
  ["index_generation", "INTEGER NOT NULL DEFAULT 0"],
  ["model_fingerprint", "TEXT NOT NULL DEFAULT ''"],
];

const V6_SQL = `
  UPDATE memories SET record_revision = revision_count;
  UPDATE memory_embeddings SET index_generation = 0, model_fingerprint = '';
`;

// M03 completes the additive v6 schema without resetting M02's generations on already-upgraded databases.
const REVIEW_SQL = `
  CREATE TABLE IF NOT EXISTS review_windows (
    nonce TEXT PRIMARY KEY, window_id TEXT NOT NULL, agent_id TEXT NOT NULL, trigger TEXT NOT NULL, cap INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, closed_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_review_windows_agent ON review_windows(agent_id, closed_at);
  CREATE TABLE IF NOT EXISTS review_ops (
    nonce TEXT NOT NULL, request_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('save', 'update', 'delete')),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'completed', 'released')),
    memory_id INTEGER, receipt TEXT, created_at TEXT NOT NULL, settled_at TEXT,
    PRIMARY KEY (nonce, request_key));
  CREATE TABLE IF NOT EXISTS memory_merges (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, relation TEXT NOT NULL,
    actor TEXT NOT NULL, source_snapshot TEXT NOT NULL, target_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL, undone_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_memory_merges_source ON memory_merges(source_id, undone_at);
`;

const V3_MEMORY_COLUMNS: [string, string][] = [
  ["use_count", "INTEGER NOT NULL DEFAULT 0"],
  ["last_used_at", "TEXT"],
  ["merged_into", "INTEGER"],
];

const V4_MEMORY_COLUMNS: [string, string][] = [
  ["shown_count", "INTEGER NOT NULL DEFAULT 0"],
  ["opened_count", "INTEGER NOT NULL DEFAULT 0"],
  ["kept_at", "TEXT"],
  ["archived_at", "TEXT"],
];

const V4_SESSION_COLUMNS: [string, string][] = [
  ["summary", "TEXT"],
  ["outcomes", "TEXT"],
  ["reviewed_at", "TEXT"],
];

// CREATE TABLE IF NOT EXISTS keeps older tables as they were, so columns are added here.
function addColumns(db: Database, table: string, added: [string, string][]): void {
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of added) {
    if (!columns.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

const V3_SQL = `
  CREATE TABLE IF NOT EXISTS agent_links (
    nonce TEXT PRIMARY KEY, agent_id TEXT, workspace_id TEXT, project_key TEXT, provider TEXT, title TEXT,
    created_at TEXT NOT NULL, linked_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_agent_links_agent ON agent_links(agent_id);
  CREATE INDEX IF NOT EXISTS ix_agent_links_workspace ON agent_links(workspace_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ix_audit_nonce ON audit_events(nonce, id);
  CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_events(created_at);
`;

// v4 rebuilds the sessions index with summaries; "." is no longer a token character, so "done." matches "done".
const V4_SQL = `
  DROP TRIGGER IF EXISTS sessions_ai;
  DROP TRIGGER IF EXISTS sessions_ad;
  DROP TRIGGER IF EXISTS sessions_au;
  DROP TABLE IF EXISTS sessions_fts;
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
  INSERT INTO sessions_fts(sessions_fts) VALUES ('rebuild');
  CREATE TABLE IF NOT EXISTS upkeep_dismissed (
    low_id INTEGER NOT NULL, high_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (low_id, high_id));
`;

// Same tokenizer as sessions_fts; the index is refilled from live memories so rowid stays the memory id.
const V5_SQL = `
  DROP TRIGGER IF EXISTS memories_ai;
  DROP TRIGGER IF EXISTS memories_ad;
  DROP TRIGGER IF EXISTS memories_au;
  DROP TABLE IF EXISTS memories_fts;
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
  INSERT INTO memories_fts(rowid, title, content, topic_key)
    SELECT id, title, content, topic_key FROM memories WHERE deleted_at IS NULL;
`;

function dropV1Vectors(db: Database): void {
  const vecTables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memories_vec_%' AND sql LIKE '%vec0%'`,
    )
    .all();
  for (const table of vecTables) db.run(`DROP TABLE ${table.name}`);
  db.run(`DROP TABLE IF EXISTS memory_embeddings`);
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS project_aliases (
    paseo_project_id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key), updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_key TEXT REFERENCES projects(key),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    topic_key TEXT,
    content_hash TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    revision_count INTEGER NOT NULL DEFAULT 1,
    duplicate_count INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'agent',
    agent_id TEXT, provider TEXT, workspace_dir TEXT, branch TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT, deleted_at TEXT,
    CHECK ((scope = 'global' AND project_key IS NULL) OR (scope = 'project' AND project_key IS NOT NULL)));
  CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_topic ON memories(scope, ifnull(project_key, ''), topic_key)
    WHERE topic_key IS NOT NULL AND deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS ix_memories_scope ON memories(scope, project_key, deleted_at, updated_at DESC);
  CREATE TABLE IF NOT EXISTS memory_versions (
    memory_id INTEGER NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (memory_id, version));
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    model TEXT NOT NULL, dims INTEGER NOT NULL, content_hash TEXT NOT NULL, embedded_at TEXT NOT NULL,
    PRIMARY KEY (memory_id, model));
  CREATE TABLE IF NOT EXISTS vec_tables (
    model TEXT NOT NULL, dims INTEGER NOT NULL, table_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    PRIMARY KEY (model, dims));
  CREATE TABLE IF NOT EXISTS sessions (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_key TEXT, agent_id TEXT NOT NULL, provider TEXT, title TEXT, workspace_dir TEXT,
    first_prompt TEXT, last_prompt TEXT, last_reply TEXT, files TEXT NOT NULL DEFAULT '[]',
    turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_key, updated_at DESC);
`;
