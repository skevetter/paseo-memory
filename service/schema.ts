// Schema and migrations for memory.db. v1 (paseo-memory 0.1) stored vectors as BLOBs keyed by
// memory alone; v2 keeps vectors only in vec0 tables, one per model, tracked in vec_tables.
// v3 (1.1) adds usage counters, merge pointers, agent links and audit events.

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 3;

export function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (current === 1) dropV1Vectors(db);
    db.run(SCHEMA_SQL);
    addV3Columns(db);
    db.run(V3_SQL);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

// CREATE TABLE IF NOT EXISTS keeps older memories tables as they were, so columns are added here.
function addV3Columns(db: Database): void {
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(memories)`)
      .all()
      .map((c) => c.name),
  );
  const added: [string, string][] = [
    ["use_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_used_at", "TEXT"],
    ["merged_into", "INTEGER"],
  ];
  for (const [name, type] of added) {
    if (!columns.has(name)) db.run(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
  }
}

// agent_links maps the nonce in an agent's memory token to its Paseo agent id. audit_events keeps
// ids and scores only, never memory content.
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

// The background indexer re-embeds every memory after this.
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
