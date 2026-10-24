import type { Database } from "bun:sqlite";
import { FatalError } from "./sqlite";

interface SchemaObject {
  name: string;
  type: string;
  sql: string;
}

// The caller disables FK actions outside its transaction and verifies all FKs before committing.
export function migrateBridgeSchema(db: Database): void {
  rebuildMemories(db);
  db.run("ALTER TABLE memory_evidence ADD COLUMN namespace_bot_id TEXT");
  db.run("ALTER TABLE source_artifacts ADD COLUMN bot_id TEXT");
  db.run(BRIDGE_SQL);
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rebuildMemories(db: Database): void {
  const schema = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
    .get();
  if (!schema) throw new FatalError("Memory table is absent; bridge migration refused.");
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(memories)").all();
  if (columns.some(({ name }) => name === "bot_id"))
    throw new FatalError("An unexpected bot_id column already exists; bridge migration refused.");
  const objects = db
    .query<SchemaObject, []>(
      "SELECT name,type,sql FROM sqlite_master WHERE tbl_name='memories' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY rowid",
    )
    .all();
  const body = memoryDefinition(schema.sql);
  const fields = columns.map(({ name }) => quoted(name)).join(",");
  const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM memories").get()?.count ?? 0;
  db.run(`CREATE TABLE memories_bridge_v9 (${body}, bot_id TEXT,
    CHECK ((scope='global' AND project_key IS NULL AND bot_id IS NULL)
      OR (scope='project' AND project_key IS NOT NULL AND bot_id IS NULL)
      OR (scope='bot' AND project_key IS NULL AND bot_id IS NOT NULL AND length(bot_id)>0)))`);
  db.run(`INSERT INTO memories_bridge_v9 (${fields}) SELECT ${fields} FROM memories`);
  const copied = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM memories_bridge_v9")
    .get()?.count;
  const changed = db
    .query(`SELECT ${fields} FROM memories EXCEPT SELECT ${fields} FROM memories_bridge_v9`)
    .get();
  if (copied !== count || changed)
    throw new FatalError("Memory namespace migration changed existing records; migration rolled back.");
  db.run("DROP TABLE memories; ALTER TABLE memories_bridge_v9 RENAME TO memories;");
  for (const object of objects) {
    if (
      object.name === "ux_memories_topic" ||
      object.name === "memory_revision_ai" ||
      object.name === "memory_revision_au"
    )
      continue;
    db.run(object.sql);
  }
  db.run(`CREATE UNIQUE INDEX ux_memories_topic
      ON memories(scope,coalesce(project_key,bot_id,''),topic_key)
      WHERE topic_key IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX ix_memories_bot ON memories(bot_id,deleted_at,updated_at DESC) WHERE scope='bot';`);
}

function memoryDefinition(sql: string): string {
  const start = sql.indexOf("(");
  const end = sql.lastIndexOf(")");
  if (start < 0 || end <= start) throw new FatalError("Unrecognized memory schema; migration refused.");
  const body = sql.slice(start + 1, end);
  const scope = /CHECK\s*\(\s*scope\s+IN\s*\(\s*'global'\s*,\s*'project'\s*\)\s*\)/i;
  // The first published schema had no scope CHECK. Its rows still pass the new
  // canonical namespace constraint during the copy; unknown later CHECKs fail closed.
  if (/CHECK\s*\(\s*scope\b/i.test(body) && !scope.test(body))
    throw new FatalError("Unrecognized memory scope constraint; migration refused.");
  return body
    .replace(scope, "")
    .replace(
      /,\s*CHECK\s*\(\s*\(\s*scope\s*=\s*'global'\s+AND\s+project_key\s+IS\s+NULL\s*\)\s+OR\s*\(\s*scope\s*=\s*'project'\s+AND\s+project_key\s+IS\s+NOT\s+NULL\s*\)\s*\)/i,
      "",
    );
}

const BRIDGE_SQL = `
  CREATE TABLE bridge_consumers (
    consumer_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
    credential_version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
    read_grants TEXT NOT NULL, write_grants TEXT NOT NULL, allowed_functions TEXT NOT NULL,
    allowed_mutations TEXT NOT NULL, allowed_mutation_purposes TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE bridge_sessions (
    session_id TEXT PRIMARY KEY, consumer_id TEXT NOT NULL REFERENCES bridge_consumers(consumer_id),
    bot_id TEXT NOT NULL, run_id TEXT NOT NULL, cycle_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    execution_id TEXT NOT NULL, intended_agent_id TEXT NOT NULL, actual_agent_id TEXT,
    session_epoch INTEGER NOT NULL CHECK(session_epoch>0), origin_json TEXT NOT NULL,
    expected_identity_json TEXT NOT NULL, ownership_json TEXT NOT NULL, grants_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','bound','released','expired','revoked')),
    lease_version INTEGER NOT NULL CHECK(lease_version>0), expires_at TEXT NOT NULL,
    session_token_hash TEXT NOT NULL UNIQUE, bootstrap_hash TEXT UNIQUE, bootstrap_expires_at TEXT,
    bootstrap_consumed_at TEXT, create_seen_at TEXT, create_seen_lease_version INTEGER,
    create_seen_config_hash TEXT, context_retrieval_id TEXT, tool_token_hash TEXT UNIQUE,
    tool_activated_epoch INTEGER, tool_revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(consumer_id,execution_id));
  CREATE UNIQUE INDEX ux_bridge_live_intended_agent ON bridge_sessions(intended_agent_id)
    WHERE state IN ('pending','bound');
  CREATE UNIQUE INDEX ux_bridge_live_actual_agent ON bridge_sessions(actual_agent_id)
    WHERE state='bound';
  CREATE INDEX ix_bridge_sessions_bot ON bridge_sessions(consumer_id,bot_id,state);
  CREATE INDEX ix_bridge_sessions_expiry ON bridge_sessions(expires_at)
    WHERE state IN ('pending','bound');
  CREATE TABLE bridge_leases (
    session_id TEXT NOT NULL REFERENCES bridge_sessions(session_id), lease_version INTEGER NOT NULL,
    session_epoch INTEGER NOT NULL, origin_json TEXT NOT NULL, grants_json TEXT NOT NULL,
    ownership_json TEXT NOT NULL, bound_at TEXT, expires_at TEXT NOT NULL, terminal_at TEXT,
    terminal_deadline TEXT, terminal_reason TEXT, terminal_window_seconds INTEGER NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(session_id,lease_version));
  CREATE TABLE bridge_requests (
    principal_id TEXT NOT NULL, endpoint TEXT NOT NULL, request_id TEXT NOT NULL,
    body_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(principal_id,endpoint,request_id));
  CREATE TABLE bridge_contexts (
    retrieval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES bridge_sessions(session_id),
    session_epoch INTEGER NOT NULL, lease_version INTEGER NOT NULL, context_json TEXT,
    memory_refs TEXT NOT NULL, evidence_refs TEXT NOT NULL, source_snapshot TEXT NOT NULL,
    policy_revision INTEGER NOT NULL, index_generation INTEGER NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'assembled' CHECK(delivery_state IN ('assembled','attached','discarded','unknown')),
    delivery_hash TEXT,
    created_at TEXT NOT NULL, invalidated_at TEXT);
  CREATE INDEX ix_bridge_context_session ON bridge_contexts(session_id,retrieval_id);
  CREATE TABLE bridge_events (
    id INTEGER PRIMARY KEY, event_ref TEXT NOT NULL UNIQUE,
    consumer_id TEXT NOT NULL REFERENCES bridge_consumers(consumer_id),
    session_id TEXT NOT NULL REFERENCES bridge_sessions(session_id), execution_id TEXT NOT NULL,
    session_epoch INTEGER NOT NULL, event_id TEXT NOT NULL, origin_lease_version INTEGER NOT NULL,
    body_hash TEXT NOT NULL, event_json TEXT, source_ref TEXT,
    processing_state TEXT NOT NULL DEFAULT 'pending' CHECK(processing_state IN ('pending','processed','rejected','invalidated')),
    created_at TEXT NOT NULL, last_error TEXT,
    UNIQUE(consumer_id,execution_id,session_epoch,event_id));
  CREATE INDEX ix_bridge_events_pending ON bridge_events(processing_state,id);
  CREATE TABLE bridge_event_sources (
    event_id INTEGER NOT NULL REFERENCES bridge_events(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('memory','artifact')),
    source_ref TEXT NOT NULL, memory_id INTEGER, revision INTEGER, evidence_id TEXT,
    PRIMARY KEY(event_id,source_kind,source_ref));
  CREATE INDEX ix_bridge_event_sources_memory ON bridge_event_sources(memory_id,event_id)
    WHERE memory_id IS NOT NULL;
`;
