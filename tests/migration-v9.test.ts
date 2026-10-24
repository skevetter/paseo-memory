import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "../service/schema";
import { openDatabase } from "../service/sqlite";

const directories: string[] = [];
const databases = new Set<Database>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const published = readFileSync(new URL("./fixtures/schema-v8.sql", import.meta.url), "utf8");
const time = "2026-10-01T00:00:00.000Z";
const records = z.array(z.record(z.string(), z.unknown()));
const numberRow = z.object({ count: z.number().int() });
const preserved = [
  "memories",
  "memory_revisions",
  "memory_versions",
  "memory_evidence",
  "memory_evidence_links",
  "source_artifacts",
  "memory_feedback",
  "model_usage",
  "memory_embeddings",
  "embedding_indexes",
  "sessions",
];
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
function open(path: string): Database {
  const db = openDatabase(path).db;
  databases.add(db);
  return db;
}
function scalar(db: Database, sql: string): number {
  return numberRow.parse(db.query(sql).get()).count;
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "paseo-memory-v9-"));
  directories.push(directory);
  const path = join(directory, "memory.db");
  const db = open(path);
  db.run(published);
  db.run(`INSERT INTO projects VALUES('project-a','Project A','/a','${time}','${time}');
    INSERT INTO meta VALUES('mutation_actor','fixture-owner'),('mutation_reason','published fixture');
    INSERT INTO memories(id,scope,project_key,type,title,content,topic_key,content_hash,pinned,revision_count,
      duplicate_count,source,agent_id,provider,workspace_dir,branch,created_at,updated_at,record_revision,
      index_generation,use_count,shown_count,opened_count,kept_at,verification_status,verified_at,
      last_retrieved_at,application_count,validated_helpful_count)
    VALUES(41,'project','project-a','decision','Boundary fixture policy','Keep approved backups before rollout',
      'shared','original-hash',1,7,3,'owner','fixture-agent','omp','/a','main','${time}','${time}',7,19,
      9,4,2,'${time}','verified','${time}','${time}',2,1);
    INSERT INTO memories(id,scope,type,title,content,topic_key,content_hash,created_at,updated_at)
      VALUES(99,'global','note','Global fixture policy','Keep the global assertion independent','shared','global-hash','${time}','${time}');
    INSERT INTO memories(id,scope,type,title,content,content_hash,created_at,updated_at,archived_at,deleted_at,state,merged_into)
      VALUES(83,'global','note','Archived fixture','Retain removed history','removed-hash','${time}','${time}','${time}','${time}','superseded',99);
    INSERT INTO memory_versions VALUES(41,6,'Prior title','Prior content','${time}');
    INSERT INTO memory_evidence(evidence_id,source_kind,source_ref,source_hash,observed_at,stored_at,actor_id,
      bot_id,run_id,cycle_id,excerpt,sensitivity,status,scope,project_key)
      VALUES('fixture-evidence','memory','memory:41@7','source-hash','${time}','${time}','fixture-owner',
      'producer-bot','producer-run','producer-cycle','Approved excerpt','private','resolved','project','project-a');
    INSERT INTO memory_evidence_links VALUES(41,7,'fixture-evidence','supports');
    INSERT INTO source_artifacts VALUES('artifact:fixture','Independent approved source','artifact-hash','global',NULL,1,'${time}','${time}');
    INSERT INTO memory_feedback VALUES('fixture-producer','feedback-1','retrieval-1',41,7,'producer-run','producer-cycle',
      'helpful','validator','["fixture-evidence"]','${time}',1,'fixture-verifier','1',NULL);
    INSERT INTO model_usage(producer_id,event_id,attempt_id,request_hash,source_sequence,stage,status,provenance,created_at)
      VALUES('fixture-runtime','usage-1','attempt-1','usage-hash',0,'provider_turn','failed','unavailable','${time}');
    INSERT INTO sessions(id,project_key,agent_id,title,first_prompt,last_reply,started_at,updated_at,summary)
      VALUES('fixture-session','project-a','fixture-agent','Fixture conversation','Original request','Original reply','${time}','${time}','Original summary');
    ALTER TABLE memories ADD COLUMN private_extension TEXT DEFAULT 'owner-extension';
    CREATE TABLE extension_writes(id INTEGER PRIMARY KEY,n INTEGER NOT NULL);
    INSERT INTO extension_writes VALUES(1,5);
    CREATE TRIGGER owner_extension_ai AFTER INSERT ON memories BEGIN UPDATE extension_writes SET n=n+1 WHERE id=1; END;
    CREATE VIRTUAL TABLE fixture_vec USING vec0(memory_id INTEGER PRIMARY KEY,scope_key TEXT PARTITION KEY,embedding FLOAT[2] distance_metric=cosine);
    INSERT INTO embedding_indexes VALUES('legacy:fixture-model:2',1,'fixture-model',2,'fixture_vec',NULL,'legacy','${time}',NULL,NULL);
    INSERT INTO memory_embeddings VALUES(41,'legacy:fixture-model:2','original-hash',19,'${time}','old-fingerprint');`);
  const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
  db.query("INSERT INTO fixture_vec(memory_id,scope_key,embedding) VALUES(?,?,?)").run(
    41,
    "project:fixture",
    vector,
  );
  return { db, path, vector };
}
function snapshot(db: Database) {
  return new Map(
    preserved.map((table) => {
      const columns = z
        .array(z.object({ name: z.string() }))
        .parse(db.query(`PRAGMA table_info(${quoted(table)})`).all())
        .map((row) => row.name);
      return [
        table,
        {
          columns,
          rows: records.parse(
            db.query(`SELECT ${columns.map(quoted).join(",")} FROM ${quoted(table)} ORDER BY rowid`).all(),
          ),
        },
      ];
    }),
  );
}
function integrity(db: Database) {
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
function knn(db: Database, vector: Uint8Array) {
  return z
    .array(z.object({ memory_id: z.number(), distance: z.number() }))
    .parse(
      db
        .query("SELECT memory_id,distance FROM fixture_vec WHERE embedding MATCH ? AND k=1 ORDER BY distance")
        .all(vector),
    );
}

it("preserves every published-v8 column, canonical snapshot, source producer and native vector during namespace rebuild", () => {
  const { db, vector } = fixture();
  const before = snapshot(db);
  const native = db.query("SELECT memory_id,scope_key,hex(embedding) AS bytes FROM fixture_vec").all();
  migrate(db);
  for (const [table, value] of before)
    expect(
      db.query(`SELECT ${value.columns.map(quoted).join(",")} FROM ${quoted(table)} ORDER BY rowid`).all(),
    ).toEqual(value.rows);
  expect(
    db
      .query("SELECT bot_id,namespace_bot_id FROM memory_evidence WHERE evidence_id='fixture-evidence'")
      .get(),
  ).toEqual({ bot_id: "producer-bot", namespace_bot_id: null });
  expect(db.query("SELECT memory_id,scope_key,hex(embedding) AS bytes FROM fixture_vec").all()).toEqual(
    native,
  );
  expect(knn(db, vector)).toEqual([{ memory_id: 41, distance: 0 }]);
  expect(db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'approved'").all()).toEqual([
    { rowid: 41 },
  ]);
  expect(scalar(db, "SELECT n AS count FROM extension_writes WHERE id=1")).toBe(5);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  integrity(db);
});

it("enforces distinct canonical bot/project/global namespaces and namespace-local topic uniqueness", () => {
  const { db } = fixture();
  migrate(db);
  const insert =
    db.query(`INSERT INTO memories(scope,project_key,bot_id,type,title,content,topic_key,content_hash,created_at,updated_at)
    VALUES(?,?,?,'note','Bot fixture','A scoped assertion','shared','bot-hash',?,?)`);
  insert.run("bot", null, "alpha", time, time);
  insert.run("bot", null, "beta", time, time);
  expect(() => insert.run("bot", null, "alpha", time, time)).toThrow();
  const contradictory: [string, string | null, string | null][] = [
    ["global", null, "alpha"],
    ["project", "project-a", "alpha"],
    ["bot", "project-a", "alpha"],
    ["bot", null, ""],
  ];
  for (const [scope, project, bot] of contradictory)
    expect(() => insert.run(scope, project, bot, time, time)).toThrow();
  expect(scalar(db, "SELECT count(*) AS count FROM memories WHERE topic_key='shared'")).toBe(4);
  expect(scalar(db, "SELECT n AS count FROM extension_writes WHERE id=1")).toBe(7);
  integrity(db);
});

it("creates full bot-aware future revisions without rewriting old canonical history or retaining current-revision feedback", () => {
  const { db } = fixture();
  const old = db.query("SELECT * FROM memory_revisions WHERE memory_id=41 ORDER BY revision").all();
  migrate(db);
  db.run("UPDATE memories SET scope='bot',project_key=NULL,bot_id='alpha',record_revision=8 WHERE id=41");
  expect(
    db.query("SELECT * FROM memory_revisions WHERE memory_id=41 AND revision<8 ORDER BY revision").all(),
  ).toEqual(old);
  const result = z
    .object({ snapshot: z.string() })
    .parse(db.query("SELECT snapshot FROM memory_revisions WHERE memory_id=41 AND revision=8").get());
  expect(z.record(z.string(), z.unknown()).parse(JSON.parse(result.snapshot))).toMatchObject({
    bot_id: "alpha",
    project_key: null,
    scope: "bot",
    private_extension: "owner-extension",
    application_count: 0,
    validated_helpful_count: 0,
    record_revision: 8,
  });
  expect(db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'approved'").all()).toEqual([
    { rowid: 41 },
  ]);
});

it("backs up WAL-only records and native vectors as schema8 and restores the backup independently", () => {
  const { db, path, vector } = fixture();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.run(`INSERT INTO memories(id,scope,type,title,content,content_hash,created_at,updated_at)
    VALUES(155,'global','note','WAL fixture','Durable WAL-only assertion','wal-hash','${time}','${time}')`);
  migrate(db);
  const metadata = z
    .object({ backupPath: z.string(), fromSchema: z.literal(8), toSchema: z.literal(9) })
    .parse(JSON.parse(readFileSync(`${path}.pre-v${SCHEMA_VERSION}-from-v8.bak.json`, "utf8")));
  const restoredPath = join(dirname(path), "restored.db");
  copyFileSync(metadata.backupPath, restoredPath);
  const restored = open(restoredPath);
  expect(restored.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  expect(restored.query("SELECT title FROM memories WHERE id=155").get()).toEqual({ title: "WAL fixture" });
  expect(knn(restored, vector)).toEqual([{ memory_id: 41, distance: 0 }]);
  integrity(restored);
  migrate(restored);
  expect(restored.query("PRAGMA user_version").get()).toEqual({ user_version: 9 });
  integrity(restored);
});

it("rolls back a late bridge-table collision including parent FKs, triggers and immutable derived bytes", () => {
  const { db, vector } = fixture();
  db.run(
    "CREATE TABLE bridge_consumers(opaque TEXT); INSERT INTO bridge_consumers VALUES('owned extension')",
  );
  const before = snapshot(db);
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  expect(() => migrate(db)).toThrow();
  expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(
    schema,
  );
  expect(snapshot(db)).toEqual(before);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(knn(db, vector)).toEqual([{ memory_id: 41, distance: 0 }]);
  db.run("UPDATE memories SET record_revision=8 WHERE id=41");
  expect(scalar(db, "SELECT count(*) AS count FROM memory_revisions WHERE memory_id=41 AND revision=8")).toBe(
    1,
  );
  integrity(db);
});

it("reopens schema9 without extra backups, canonical changes or authority writes", () => {
  const { db, path } = fixture();
  migrate(db);
  const before = snapshot(db);
  const files = readdirSync(dirname(path)).sort();
  const changes = db.query("SELECT total_changes() AS count").get();
  migrate(db);
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT total_changes() AS count").get()).toEqual(changes);
  expect(readdirSync(dirname(path)).sort()).toEqual(files);
});

it("refuses opaque future schema before backup, FK toggles or database/WAL writes", () => {
  const { db, path } = fixture();
  db.run(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  const files = readdirSync(dirname(path)).sort();
  // SQLite reads may update transient SHM read marks, not database or WAL pages.
  const mainBytes = readFileSync(path);
  const walBytes = readFileSync(`${path}-wal`);
  expect(() => migrate(db)).toThrow(SchemaTooNewError);
  expect(readdirSync(dirname(path)).sort()).toEqual(files);
  expect(readFileSync(path)).toEqual(mainBytes);
  expect(readFileSync(`${path}-wal`)).toEqual(walBytes);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});
