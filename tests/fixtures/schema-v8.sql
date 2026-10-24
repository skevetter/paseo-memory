-- Independent published v1.5.0 schema8, generated from release3993a985a0d16af7425b337a9fd0fd6d6e557ff1.
-- No current migration or version downgrade was used.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE projects (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE project_aliases (
    paseo_project_id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key), updated_at TEXT NOT NULL);

CREATE TABLE memories (
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
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT, deleted_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, merged_into INTEGER, shown_count INTEGER NOT NULL DEFAULT 0, opened_count INTEGER NOT NULL DEFAULT 0, kept_at TEXT, archived_at TEXT, index_generation INTEGER NOT NULL DEFAULT 1, record_revision INTEGER NOT NULL DEFAULT 1, record_kind TEXT NOT NULL DEFAULT 'fact', state TEXT NOT NULL DEFAULT 'active', verification_status TEXT NOT NULL DEFAULT 'unverified', valid_from TEXT, valid_until TEXT, verified_at TEXT, last_retrieved_at TEXT, application_count INTEGER NOT NULL DEFAULT 0, validated_helpful_count INTEGER NOT NULL DEFAULT 0, validated_harmful_count INTEGER NOT NULL DEFAULT 0,
    CHECK ((scope = 'global' AND project_key IS NULL) OR (scope = 'project' AND project_key IS NOT NULL)));

CREATE UNIQUE INDEX ux_memories_topic ON memories(scope, ifnull(project_key, ''), topic_key)
    WHERE topic_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX ix_memories_scope ON memories(scope, project_key, deleted_at, updated_at DESC);

CREATE TABLE memory_versions (
    memory_id INTEGER NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (memory_id, version));

CREATE TABLE sessions (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_key TEXT, agent_id TEXT NOT NULL, provider TEXT, title TEXT, workspace_dir TEXT,
    first_prompt TEXT, last_prompt TEXT, last_reply TEXT, files TEXT NOT NULL DEFAULT '[]',
    turns INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, summary TEXT, outcomes TEXT, reviewed_at TEXT);

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

CREATE TABLE upkeep_dismissed (
    low_id INTEGER NOT NULL, high_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (low_id, high_id));

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

CREATE TABLE review_windows (
    nonce TEXT PRIMARY KEY, window_id TEXT NOT NULL, agent_id TEXT NOT NULL, trigger TEXT NOT NULL, cap INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, closed_at TEXT);

CREATE INDEX ix_review_windows_agent ON review_windows(agent_id, closed_at);

CREATE TABLE review_ops (
    nonce TEXT NOT NULL, request_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('save', 'update', 'delete')),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'completed', 'released')),
    memory_id INTEGER, receipt TEXT, created_at TEXT NOT NULL, settled_at TEXT,
    PRIMARY KEY (nonce, request_key));

CREATE TABLE memory_merges (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, relation TEXT NOT NULL,
    actor TEXT NOT NULL, source_snapshot TEXT NOT NULL, target_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL, undone_at TEXT);

CREATE INDEX ix_memory_merges_source ON memory_merges(source_id, undone_at);

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
    evidence_refs TEXT NOT NULL, created_at TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, verifier_id TEXT, verifier_version TEXT, support_valid_until TEXT, PRIMARY KEY (producer_id, event_id));

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

CREATE TABLE embedding_indexes (
    fingerprint TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE, model TEXT NOT NULL, dims INTEGER NOT NULL,
    table_name TEXT UNIQUE, identity_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('building','ready','retired','legacy')),
    created_at TEXT, ready_at TEXT, retired_at TEXT);

CREATE TABLE memory_embeddings (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    index_fingerprint TEXT NOT NULL REFERENCES embedding_indexes(fingerprint) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,index_generation INTEGER NOT NULL,embedded_at TEXT NOT NULL,
    legacy_model_fingerprint TEXT,PRIMARY KEY (memory_id,index_fingerprint));

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

CREATE TRIGGER memory_revision_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        VALUES (new.id, new.record_revision, json_object('id', new."id", 'scope', new."scope", 'project_key', new."project_key", 'type', new."type", 'title', new."title", 'content', new."content", 'topic_key', new."topic_key", 'content_hash', new."content_hash", 'pinned', new."pinned", 'revision_count', new."revision_count", 'duplicate_count', new."duplicate_count", 'source', new."source", 'agent_id', new."agent_id", 'provider', new."provider", 'workspace_dir', new."workspace_dir", 'branch', new."branch", 'created_at', new."created_at", 'updated_at', new."updated_at", 'last_seen_at', new."last_seen_at", 'deleted_at', new."deleted_at", 'use_count', new."use_count", 'last_used_at', new."last_used_at", 'merged_into', new."merged_into", 'shown_count', new."shown_count", 'opened_count', new."opened_count", 'kept_at', new."kept_at", 'archived_at', new."archived_at", 'index_generation', new."index_generation", 'record_revision', new."record_revision", 'record_kind', new."record_kind", 'state', new."state", 'verification_status', new."verification_status", 'valid_from', new."valid_from", 'valid_until', new."valid_until", 'verified_at', new."verified_at", 'last_retrieved_at', new."last_retrieved_at", 'application_count', new."application_count", 'validated_helpful_count', new."validated_helpful_count", 'validated_harmful_count', new."validated_harmful_count"), new.updated_at,
          (SELECT value FROM meta WHERE key = 'mutation_actor'), (SELECT value FROM meta WHERE key = 'mutation_reason'), 0);
    END;

CREATE TRIGGER memory_revision_au AFTER UPDATE ON memories WHEN new.record_revision != old.record_revision BEGIN
      UPDATE memories SET application_count=0,validated_helpful_count=0,validated_harmful_count=0
        WHERE id=new.id AND (application_count!=0 OR validated_helpful_count!=0 OR validated_harmful_count!=0);
      INSERT INTO memory_revisions (memory_id, revision, snapshot, changed_at, actor_id, reason, legacy_metadata_unknown)
        SELECT new.id,new.record_revision,json_object('id', m."id", 'scope', m."scope", 'project_key', m."project_key", 'type', m."type", 'title', m."title", 'content', m."content", 'topic_key', m."topic_key", 'content_hash', m."content_hash", 'pinned', m."pinned", 'revision_count', m."revision_count", 'duplicate_count', m."duplicate_count", 'source', m."source", 'agent_id', m."agent_id", 'provider', m."provider", 'workspace_dir', m."workspace_dir", 'branch', m."branch", 'created_at', m."created_at", 'updated_at', m."updated_at", 'last_seen_at', m."last_seen_at", 'deleted_at', m."deleted_at", 'use_count', m."use_count", 'last_used_at', m."last_used_at", 'merged_into', m."merged_into", 'shown_count', m."shown_count", 'opened_count', m."opened_count", 'kept_at', m."kept_at", 'archived_at', m."archived_at", 'index_generation', m."index_generation", 'record_revision', m."record_revision", 'record_kind', m."record_kind", 'state', m."state", 'verification_status', m."verification_status", 'valid_from', m."valid_from", 'valid_until', m."valid_until", 'verified_at', m."verified_at", 'last_retrieved_at', m."last_retrieved_at", 'application_count', m."application_count", 'validated_helpful_count', m."validated_helpful_count", 'validated_harmful_count', m."validated_harmful_count"),new.updated_at,
          (SELECT value FROM meta WHERE key='mutation_actor'),(SELECT value FROM meta WHERE key='mutation_reason'),0
        FROM memories m WHERE m.id=new.id;
    END;
PRAGMA user_version=8;
