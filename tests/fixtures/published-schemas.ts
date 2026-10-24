import type { Database } from "bun:sqlite";

// Literal statements the published paseo-memory releases ran for a fresh database.
// Sources (git show): a0664de v2, dfec780 v3, 0be2c97 v4, c741368 v5, bce8ffa v6.
// bce8ffa is the v6 that 1093bff extends with review tables; this fixture omits them.
// Never derive these from the current service/schema.ts.

export type PublishedSchemaVersion = 2 | 3 | 4 | 5 | 6;

const SCHEMA_V2_SQL = `
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
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, topic_key, content = 'memories', content_rowid = 'id',
    tokenize = "porter unicode61 tokenchars '_-./'");
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(rowid, title, content, topic_key) VALUES (new.id, new.title, new.content, new.topic_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories WHEN old.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      VALUES ('delete', old.id, old.title, old.content, old.topic_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      SELECT 'delete', old.id, old.title, old.content, old.topic_key WHERE old.deleted_at IS NULL;
    INSERT INTO memories_fts(rowid, title, content, topic_key)
      SELECT new.id, new.title, new.content, new.topic_key WHERE new.deleted_at IS NULL;
  END;
  CREATE TABLE IF NOT EXISTS sessions (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_key TEXT, agent_id TEXT NOT NULL, provider TEXT, title TEXT, workspace_dir TEXT,
    first_prompt TEXT, last_prompt TEXT, last_reply TEXT, files TEXT NOT NULL DEFAULT '[]',
    turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_key, updated_at DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    title, first_prompt, last_prompt, last_reply, content = 'sessions', content_rowid = 'rowid',
    tokenize = "porter unicode61 tokenchars '_-./'");
  CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, title, first_prompt, last_prompt, last_reply)
      VALUES (new.rowid, new.title, new.first_prompt, new.last_prompt, new.last_reply);
  END;
  CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, first_prompt, last_prompt, last_reply)
      VALUES ('delete', old.rowid, old.title, old.first_prompt, old.last_prompt, old.last_reply);
  END;
  CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, first_prompt, last_prompt, last_reply)
      VALUES ('delete', old.rowid, old.title, old.first_prompt, old.last_prompt, old.last_reply);
    INSERT INTO sessions_fts(rowid, title, first_prompt, last_prompt, last_reply)
      VALUES (new.rowid, new.title, new.first_prompt, new.last_prompt, new.last_reply);
  END;
`;

// v4 base: v2 minus sessions_fts, which V4_SQL creates.
const SCHEMA_V4_SQL = `
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
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, topic_key, content = 'memories', content_rowid = 'id',
    tokenize = "porter unicode61 tokenchars '_-./'");
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(rowid, title, content, topic_key) VALUES (new.id, new.title, new.content, new.topic_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories WHEN old.deleted_at IS NULL BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      VALUES ('delete', old.id, old.title, old.content, old.topic_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, topic_key)
      SELECT 'delete', old.id, old.title, old.content, old.topic_key WHERE old.deleted_at IS NULL;
    INSERT INTO memories_fts(rowid, title, content, topic_key)
      SELECT new.id, new.title, new.content, new.topic_key WHERE new.deleted_at IS NULL;
  END;
  CREATE TABLE IF NOT EXISTS sessions (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_key TEXT, agent_id TEXT NOT NULL, provider TEXT, title TEXT, workspace_dir TEXT,
    first_prompt TEXT, last_prompt TEXT, last_reply TEXT, files TEXT NOT NULL DEFAULT '[]',
    turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_key, updated_at DESC);
`;

// v5 base: no FTS tables; V5_SQL creates memories_fts.
const SCHEMA_V5_SQL = `
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

const V3_ALTERS = [
  "ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN last_used_at TEXT",
  "ALTER TABLE memories ADD COLUMN merged_into INTEGER",
];

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

const V4_ALTERS = [
  "ALTER TABLE memories ADD COLUMN shown_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN opened_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN kept_at TEXT",
  "ALTER TABLE memories ADD COLUMN archived_at TEXT",
  "ALTER TABLE sessions ADD COLUMN summary TEXT",
  "ALTER TABLE sessions ADD COLUMN outcomes TEXT",
  "ALTER TABLE sessions ADD COLUMN reviewed_at TEXT",
  "ALTER TABLE agent_links ADD COLUMN tools INTEGER NOT NULL DEFAULT 1",
];

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

const V6_ALTERS = [
  "ALTER TABLE memories ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE memories ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE memory_embeddings ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memory_embeddings ADD COLUMN model_fingerprint TEXT NOT NULL DEFAULT ''",
];

const V6_SQL = `
  UPDATE memories SET record_revision = revision_count;
  UPDATE memory_embeddings SET index_generation = 0, model_fingerprint = '';
`;

// Statements the published migrate ran, in order, for a fresh database at each version.
const PUBLISHED_STEPS: Record<PublishedSchemaVersion, readonly string[]> = {
  2: [SCHEMA_V2_SQL],
  3: [SCHEMA_V2_SQL, ...V3_ALTERS, V3_SQL],
  4: [SCHEMA_V4_SQL, ...V3_ALTERS, V3_SQL, ...V4_ALTERS, V4_SQL],
  5: [SCHEMA_V5_SQL, ...V3_ALTERS, V3_SQL, ...V4_ALTERS, V4_SQL, V5_SQL],
  6: [SCHEMA_V5_SQL, ...V3_ALTERS, V3_SQL, ...V4_ALTERS, V4_SQL, V5_SQL, ...V6_ALTERS, V6_SQL],
};

// Builds the schema a published release left behind, without running current migrate.
export function createPublishedSchema(db: Database, version: PublishedSchemaVersion): void {
  db.transaction(() => {
    for (const sql of PUBLISHED_STEPS[version]) db.run(sql);
    db.run(`PRAGMA user_version = ${version}`);
  })();
}
