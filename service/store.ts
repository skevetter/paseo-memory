// Single-file SQLite memory store: memories (global and project scope), versions, session
// digests, FTS5 keyword search, sqlite-vec KNN per embedding model, and reciprocal rank fusion.

import type { Database } from "bun:sqlite";
import type { ProjectRef, SearchScope } from "../shared/service-api";
import type { Embedder, EmbedKind, TierSpec } from "./embedder";
import { redact } from "./redact";
import { migrate } from "./schema";
import { recordTurn, type SessionHit, type SessionRow, searchSessions, type TurnInput } from "./sessions";
import { errorText, openDatabase } from "./sqlite";
import { clip, ftsQuery, RRF_K, sha256 } from "./text";
import { dropVectors, type Neighbor, scopeKey, VectorIndex, type VectorTarget, vecTables } from "./vectors";

export type { ProjectRef, SearchScope, SessionRow };
export { clip, ftsQuery, scopeKey };
export type Scope = "global" | "project";

export interface MemoryRow {
  id: number;
  scope: Scope;
  project_key: string | null;
  type: string;
  title: string;
  content: string;
  topic_key: string | null;
  content_hash: string;
  pinned: number;
  revision_count: number;
  duplicate_count: number;
  source: string;
  agent_id: string | null;
  provider: string | null;
  workspace_dir: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export type MemoryWithProject = MemoryRow & { project_name: string | null };

export interface SaveInput {
  title: string;
  content: string;
  type: string;
  scope: Scope;
  project: ProjectRef | null;
  topicKey?: string | null;
  pinned?: boolean;
  force?: boolean;
  source?: string;
  agentId?: string | null;
  provider?: string | null;
  workspaceDir?: string | null;
}

export type SaveResult =
  | { status: "created" | "updated" | "duplicate"; id: number }
  | {
      status: "possible_duplicate";
      id: null;
      candidates: { id: number; title: string; similarity: number }[];
    };

export interface MemoryHit {
  kind: "memory";
  id: string;
  title: string;
  type: string;
  scope: Scope;
  projectKey: string | null;
  projectName: string | null;
  preview: string;
  pinned: boolean;
  updatedAt: string;
  score: number;
}

export type SearchHit = MemoryHit | SessionHit;

export interface SearchInput {
  query: string;
  project: ProjectRef | null;
  scope?: SearchScope;
  type?: string;
  limit?: number;
  includeSessions?: boolean;
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  type?: string;
  pinned?: boolean;
  topicKey?: string | null;
}

export interface StoreOptions {
  path: string;
  sqlitePath?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

// A save after redaction, with its resolved scope, content hash and (optional) vector.
interface SaveDraft {
  input: SaveInput;
  title: string;
  content: string;
  scope: Scope;
  projectKey: string | null;
  hash: string;
  topicKey: string | null;
  vector: Float32Array | null;
}

interface SqlFilter {
  where: string;
  params: (string | number)[];
}

type IndexRow = Pick<MemoryRow, "id" | "title" | "content" | "scope" | "project_key" | "content_hash">;

const KNN_K = 50;
const INDEX_BATCH = 16;

export class MemoryStore {
  readonly path: string;
  readonly sqliteLibrary: string | null;
  readonly sqliteVersion: string;
  readonly sqliteVecVersion: string;
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private embedder: Embedder | null = null;
  private vectors: VectorIndex | null = null;
  private indexing: Promise<void> | null = null;
  private indexAgain = false;
  private closed = false;

  constructor(options: StoreOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    const opened = openDatabase(options.path, options.sqlitePath ?? null);
    this.db = opened.db;
    this.sqliteLibrary = opened.sqliteLibrary;
    this.sqliteVersion = opened.sqliteVersion;
    this.sqliteVecVersion = opened.sqliteVecVersion;
    migrate(this.db);
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  get activeSpec(): TierSpec | null {
    return this.embedder?.spec ?? null;
  }

  // Activates a model: creates its vec0 table and embeds, in the background, every memory that
  // has no current vector for it. Keyword search keeps working while that runs.
  setEmbedder(embedder: Embedder | null): void {
    this.embedder = embedder;
    this.vectors = embedder ? new VectorIndex(this.db, embedder.spec, () => this.ts()) : null;
    if (!embedder) return;
    this.setMeta("embedding_model", embedder.spec.model);
    this.setMeta("embedding_dims", String(embedder.spec.dims));
    this.scheduleIndex();
  }

  // ---------- projects ----------

  upsertProject(project: ProjectRef): void {
    const ts = this.ts();
    this.db
      .query(
        `INSERT INTO projects (key, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name,
           root_path = coalesce(excluded.root_path, projects.root_path), updated_at = excluded.updated_at`,
      )
      .run(project.key, project.name, project.rootPath, ts, ts);
    if (!project.paseoProjectId) return;
    this.db
      .query(
        `INSERT INTO project_aliases (paseo_project_id, project_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(paseo_project_id) DO UPDATE SET project_key = excluded.project_key, updated_at = excluded.updated_at`,
      )
      .run(project.paseoProjectId, project.key, ts);
  }

  projectByPaseoId(paseoProjectId: string): ProjectRef | null {
    const row = this.db
      .query<{ key: string; name: string; root_path: string | null }, [string]>(
        `SELECT p.key, p.name, p.root_path FROM project_aliases a JOIN projects p ON p.key = a.project_key
         WHERE a.paseo_project_id = ?`,
      )
      .get(paseoProjectId);
    return row ? { key: row.key, name: row.name, rootPath: row.root_path, paseoProjectId } : null;
  }

  projectByKey(key: string): ProjectRef | null {
    const row = this.db
      .query<{ name: string; root_path: string | null }, [string]>(
        `SELECT name, root_path FROM projects WHERE key = ?`,
      )
      .get(key);
    return row ? { key, name: row.name, rootPath: row.root_path, paseoProjectId: null } : null;
  }

  // ---------- memories ----------

  async save(input: SaveInput): Promise<SaveResult> {
    const title = redact(input.title).trim().slice(0, 200);
    const content = redact(input.content).trim();
    if (!title || !content) throw new Error("title and content are required");
    const vector = await this.embedOne(`${title}\n${content}`, "document");
    const scope: Scope = input.scope === "project" && input.project ? "project" : "global";
    const draft: SaveDraft = {
      input,
      title,
      content,
      scope,
      projectKey: scope === "project" ? (input.project?.key ?? null) : null,
      hash: sha256(`${input.type}\n${title}\n${content}`),
      topicKey: input.topicKey?.trim() || null,
      vector,
    };
    // Everything below is synchronous, so no other request interleaves with the checks.
    return this.db.transaction(() => this.saveNow(draft))();
  }

  get(ids: number[]): MemoryWithProject[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare<MemoryWithProject, number[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE m.id IN (${ids.map(() => "?").join(",")}) AND m.deleted_at IS NULL`,
      )
      .all(...ids);
    const ts = this.ts();
    const touch = this.db.query(`UPDATE memories SET last_seen_at = ? WHERE id = ?`);
    for (const row of rows) touch.run(ts, row.id);
    return rows;
  }

  // Text changes drop the memory's vectors; the background indexer embeds the new text.
  update(id: number, patch: MemoryPatch): boolean {
    const existing = this.db
      .query<MemoryRow, [number]>(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
      .get(id);
    if (!existing) return false;
    const textChanged = patch.title !== undefined || patch.content !== undefined;
    if (textChanged) this.snapshot(existing);
    const next = patched(existing, patch);
    this.db
      .query(
        `UPDATE memories SET title = ?, content = ?, type = ?, pinned = ?, topic_key = ?, content_hash = ?,
         revision_count = revision_count + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.content,
        next.type,
        next.pinned,
        next.topicKey,
        next.hash,
        textChanged ? 1 : 0,
        this.ts(),
        id,
      );
    if (next.hash !== existing.content_hash) {
      dropVectors(this.db, id);
      this.scheduleIndex();
    }
    return true;
  }

  delete(id: number, hard = false): boolean {
    const changed = hard
      ? this.db.query(`DELETE FROM memories WHERE id = ?`).run(id).changes
      : this.db
          .query(`UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
          .run(this.ts(), id).changes;
    if (changed) dropVectors(this.db, id);
    return changed > 0;
  }

  list(input: {
    project: ProjectRef | null;
    scope?: SearchScope;
    limit?: number;
    pinnedOnly?: boolean;
  }): MemoryHit[] {
    const filter = scopeFilter(input.scope ?? "all", input.project);
    const pinned = input.pinnedOnly ? " AND m.pinned = 1" : "";
    return this.db
      .query<MemoryWithProject, (string | number)[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE ${filter.where}${pinned} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(...filter.params, input.limit ?? 50)
      .map((row) => memoryHit(row, 0));
  }

  // FTS5 BM25 and vector KNN fused by reciprocal rank, then boosted for pinned, recent and
  // project-scoped memories.
  async search(input: SearchInput): Promise<SearchHit[]> {
    const scope = input.scope ?? "all";
    const limit = input.limit ?? 8;
    const query = input.query.trim();
    if (!query) return this.list({ project: input.project, scope, limit });
    const queryVector = await this.embedOne(query, "query");
    if (this.closed) return [];

    const filter = scopeFilter(scope, input.project, input.type);
    const ranks = new Map<number, number>();
    addRanks(ranks, this.keywordIds(query, filter));
    if (query.length < 3 || ranks.size === 0) addRanks(ranks, this.likeIds(query, filter));
    if (queryVector) addRanks(ranks, this.vectorIds(queryVector, { ...input, scope }));

    const hits: SearchHit[] = this.boostedHits(ranks);
    if (input.includeSessions) {
      hits.push(...searchSessions(this.db, { query, project: input.project, scope, limit }));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------- sessions ----------

  recordTurn(input: TurnInput): void {
    if (input.project) this.upsertProject(input.project);
    recordTurn(this.db, input, this.ts());
  }

  endSession(agentId: string): void {
    this.db
      .query(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(this.ts(), agentId);
  }

  recentSessions(projectKey: string | null, limit: number, excludeAgentId?: string): SessionRow[] {
    return this.db
      .query<SessionRow, [string, string, number]>(
        `SELECT * FROM sessions WHERE ifnull(project_key, '') = ? AND id != ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(projectKey ?? "", excludeAgentId ?? "", limit);
  }

  pruneSessions(retentionDays: number): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    // bun:sqlite `changes` includes rows the FTS triggers touch, so count the deleted ids instead.
    return this.db.query(`DELETE FROM sessions WHERE updated_at < ? RETURNING id`).all(cutoff).length;
  }

  // ---------- status ----------

  stats(): { memories: number; sessions: number; projects: number } {
    const one = (sql: string) => this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      memories: one(`SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL`),
      sessions: one(`SELECT count(*) AS n FROM sessions`),
      projects: one(`SELECT count(*) AS n FROM projects`),
    };
  }

  // Memories that lack a current vector for the active model.
  pendingEmbeddings(): number {
    if (!this.embedder) return 0;
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
         WHERE m.deleted_at IS NULL AND (e.memory_id IS NULL OR e.content_hash != m.content_hash)`,
      )
      .get(this.embedder.spec.model);
    return row?.n ?? 0;
  }

  embeddingModels(): { model: string; dims: number; count: number }[] {
    return this.db
      .query<{ model: string; dims: number; count: number }, []>(
        `SELECT model, dims, count(*) AS count FROM memory_embeddings GROUP BY model, dims ORDER BY model`,
      )
      .all();
  }

  vecTables(): { model: string; dims: number; table_name: string }[] {
    return vecTables(this.db);
  }

  // Resolves once every memory has a current vector for the active model (or indexing gave up on it).
  async indexPending(): Promise<void> {
    while (this.indexing) await this.indexing;
    this.scheduleIndex();
    while (this.indexing) await this.indexing;
  }

  // ---------- save internals ----------

  private saveNow(draft: SaveDraft): SaveResult {
    if (draft.input.project) this.upsertProject(draft.input.project);
    return (
      this.updateByTopic(draft) ??
      this.countExactDuplicate(draft) ??
      this.nearDuplicates(draft) ??
      this.insert(draft)
    );
  }

  private updateByTopic(draft: SaveDraft): SaveResult | null {
    if (!draft.topicKey) return null;
    const existing = this.db
      .query<MemoryRow, [string, string, string]>(
        `SELECT * FROM memories WHERE scope = ? AND ifnull(project_key, '') = ? AND topic_key = ? AND deleted_at IS NULL`,
      )
      .get(draft.scope, draft.projectKey ?? "", draft.topicKey);
    if (!existing) return null;
    this.snapshot(existing);
    const { input } = draft;
    this.db
      .query(
        `UPDATE memories SET title = ?, content = ?, type = ?, content_hash = ?, pinned = max(pinned, ?),
         revision_count = revision_count + 1, updated_at = ?, agent_id = coalesce(?, agent_id),
         provider = coalesce(?, provider), workspace_dir = coalesce(?, workspace_dir) WHERE id = ?`,
      )
      .run(
        draft.title,
        draft.content,
        input.type,
        draft.hash,
        input.pinned ? 1 : 0,
        this.ts(),
        input.agentId ?? null,
        input.provider ?? null,
        input.workspaceDir ?? null,
        existing.id,
      );
    this.storeVector(this.target(existing.id, draft), draft.vector);
    return { status: "updated", id: existing.id };
  }

  private countExactDuplicate(draft: SaveDraft): SaveResult | null {
    const same = this.db
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM memories WHERE content_hash = ? AND scope = ? AND ifnull(project_key, '') = ? AND deleted_at IS NULL`,
      )
      .get(draft.hash, draft.scope, draft.projectKey ?? "");
    if (!same) return null;
    this.db
      .query(`UPDATE memories SET duplicate_count = duplicate_count + 1, last_seen_at = ? WHERE id = ?`)
      .run(this.ts(), same.id);
    return { status: "duplicate", id: same.id };
  }

  private nearDuplicates(draft: SaveDraft): SaveResult | null {
    if (!draft.vector || !this.vectors || draft.input.force || draft.topicKey) return null;
    const threshold = this.vectors.spec.duplicateThreshold;
    const near = this.vectors
      .knn(draft.vector, scopeKey(draft.scope, draft.projectKey), 3)
      .filter((n) => n.similarity >= threshold);
    const titles = this.titles(near.map((n) => n.id));
    const candidates = near
      .filter((n) => titles.has(n.id))
      .map((n) => ({
        id: n.id,
        title: titles.get(n.id) ?? "",
        similarity: Math.round(n.similarity * 1000) / 1000,
      }));
    return candidates.length > 0 ? { status: "possible_duplicate", id: null, candidates } : null;
  }

  private insert(draft: SaveDraft): SaveResult {
    const { input } = draft;
    const ts = this.ts();
    const result = this.db
      .query(
        `INSERT INTO memories (scope, project_key, type, title, content, topic_key, content_hash, pinned,
          source, agent_id, provider, workspace_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.scope,
        draft.projectKey,
        input.type,
        draft.title,
        draft.content,
        draft.topicKey,
        draft.hash,
        input.pinned ? 1 : 0,
        input.source ?? "agent",
        input.agentId ?? null,
        input.provider ?? null,
        input.workspaceDir ?? null,
        ts,
        ts,
      );
    const id = Number(result.lastInsertRowid);
    this.storeVector(this.target(id, draft), draft.vector);
    return { status: "created", id };
  }

  private target(id: number, draft: SaveDraft): VectorTarget {
    return { id, partition: scopeKey(draft.scope, draft.projectKey), hash: draft.hash };
  }

  // Writes the vector for the active model, or queues the memory for the background indexer.
  private storeVector(target: VectorTarget, vector: Float32Array | null): void {
    if (!this.vectors) return;
    if (vector) this.vectors.write(target, vector);
    else this.scheduleIndex();
  }

  private snapshot(row: MemoryRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO memory_versions (memory_id, version, title, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.revision_count, row.title, row.content, row.updated_at);
  }

  // ---------- search internals ----------

  private async embedOne(text: string, kind: EmbedKind): Promise<Float32Array | null> {
    const embedder = this.embedder;
    if (!embedder) return null;
    try {
      const [vector] = await embedder.embed([text], kind);
      // A model switch while embedding makes the vector useless for the new tables.
      return this.embedder === embedder ? (vector ?? null) : null;
    } catch (error) {
      this.log(`${kind} embedding failed, continuing without a vector: ${errorText(error)}`);
      return null;
    }
  }

  private keywordIds(query: string, filter: SqlFilter): number[] {
    const fts = ftsQuery(query);
    if (!fts) return [];
    return this.db
      .query<{ id: number }, (string | number)[]>(
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND ${filter.where}
         ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0) LIMIT 50`,
      )
      .all(fts, ...filter.params)
      .map((r) => r.id);
  }

  // Short or unmatched queries fall back to substring matching.
  private likeIds(query: string, filter: SqlFilter): number[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .query<{ id: number }, (string | number)[]>(
        `SELECT m.id FROM memories m WHERE (m.title LIKE ? OR m.content LIKE ? OR m.topic_key LIKE ?)
         AND ${filter.where} ORDER BY m.updated_at DESC LIMIT 20`,
      )
      .all(like, like, like, ...filter.params)
      .map((r) => r.id);
  }

  // KNN in the global and project partitions, kept above the tier's search floor.
  private vectorIds(vector: Float32Array, input: SearchInput & { scope: SearchScope }): number[] {
    const vectors = this.vectors;
    if (!vectors) return [];
    const partitions: string[] = [];
    if (input.scope !== "project") partitions.push(scopeKey("global", null));
    if (input.scope !== "global" && input.project) partitions.push(scopeKey("project", input.project.key));
    const near = this.liveNeighbors(
      partitions.flatMap((partition) => vectors.knn(vector, partition, KNN_K)),
      input.type,
    );
    const { min, relative } = vectors.spec.searchFloor;
    const floor = Math.max(min, (near[0]?.similarity ?? 0) * relative);
    return near
      .filter((n) => n.similarity >= floor)
      .slice(0, 20)
      .map((n) => n.id);
  }

  private liveNeighbors(near: Neighbor[], type?: string): Neighbor[] {
    if (near.length === 0) return near;
    const typeClause = type ? "AND type = ?" : "";
    const live = new Set(
      this.db
        .prepare<{ id: number }, (string | number)[]>(
          `SELECT id FROM memories WHERE deleted_at IS NULL ${typeClause} AND id IN (${near.map(() => "?").join(",")})`,
        )
        .all(...(type ? [type] : []), ...near.map((n) => n.id))
        .map((r) => r.id),
    );
    return near.filter((n) => live.has(n.id)).sort((a, b) => b.similarity - a.similarity);
  }

  private boostedHits(ranks: Map<number, number>): MemoryHit[] {
    const ids = [...ranks.keys()];
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare<MemoryWithProject, number[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE m.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    const nowMs = this.now().getTime();
    return rows.map((row) => memoryHit(row, (ranks.get(row.id) ?? 0) * boost(row, nowMs)));
  }

  private titles(ids: number[]): Map<number, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare<{ id: number; title: string }, number[]>(
        `SELECT id, title FROM memories WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  // ---------- background indexing ----------

  private scheduleIndex(): void {
    if (!this.embedder || this.closed) return;
    if (this.indexing) {
      this.indexAgain = true;
      return;
    }
    this.indexing = this.runIndex()
      .catch((error: unknown) => this.log(`background embedding failed: ${errorText(error)}`))
      .finally(() => {
        this.indexing = null;
        if (!this.indexAgain) return;
        this.indexAgain = false;
        this.scheduleIndex();
      });
  }

  // Embeds pending memories in id order, one batch at a time, until none remain or the model changes.
  private async runIndex(): Promise<void> {
    const embedder = this.embedder;
    if (!embedder) return;
    const model = embedder.spec.model;
    const active = () => !this.closed && this.embedder === embedder;
    let done = 0;
    let rows = this.pendingBatch(model, 0);
    while (rows.length > 0 && active()) {
      const vectors = await this.embedBatch(embedder, rows);
      if (vectors && active()) done += this.writeBatch(rows, vectors);
      rows = active() ? this.pendingBatch(model, rows.at(-1)?.id ?? Number.MAX_SAFE_INTEGER) : [];
    }
    if (done > 0) this.log(`embedded ${done} memories with ${model}`);
  }

  private embedBatch(embedder: Embedder, rows: IndexRow[]): Promise<Float32Array[] | null> {
    const texts = rows.map((r) => `${r.title}\n${r.content}`);
    return embedder.embed(texts, "document").catch((error: unknown) => {
      this.log(`embedding batch ending at #${rows.at(-1)?.id} failed, skipped: ${errorText(error)}`);
      return null;
    });
  }

  private pendingBatch(model: string, afterId: number): IndexRow[] {
    return this.db
      .query<IndexRow, [string, number, number]>(
        `SELECT m.id, m.title, m.content, m.scope, m.project_key, m.content_hash FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
         WHERE m.deleted_at IS NULL AND m.id > ? AND (e.memory_id IS NULL OR e.content_hash != m.content_hash)
         ORDER BY m.id LIMIT ?`,
      )
      .all(model, afterId, INDEX_BATCH);
  }

  // Skips rows edited while the batch was embedding; the next pass picks them up.
  private writeBatch(rows: IndexRow[], vectors: Float32Array[]): number {
    const current = this.db.query<{ content_hash: string }, [number]>(
      `SELECT content_hash FROM memories WHERE id = ? AND deleted_at IS NULL`,
    );
    let written = 0;
    this.db.transaction(() => {
      rows.forEach((row, i) => {
        const vector = vectors[i];
        if (!vector || current.get(row.id)?.content_hash !== row.content_hash) return;
        this.vectors?.write(
          { id: row.id, partition: scopeKey(row.scope, row.project_key), hash: row.content_hash },
          vector,
        );
        written++;
      });
    })();
    return written;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private ts(): string {
    return this.now().toISOString();
  }
}

// ---------- helpers ----------

function patched(existing: MemoryRow, patch: MemoryPatch) {
  const title = patch.title !== undefined ? redact(patch.title).trim() : existing.title;
  const content = patch.content !== undefined ? redact(patch.content).trim() : existing.content;
  const type = patch.type ?? existing.type;
  const pinnedFlag = patch.pinned === undefined ? existing.pinned : Number(patch.pinned);
  return {
    title,
    content,
    type,
    pinned: pinnedFlag,
    topicKey: patch.topicKey === undefined ? existing.topic_key : patch.topicKey,
    hash: sha256(`${type}\n${title}\n${content}`),
  };
}

function scopeFilter(scope: SearchScope, project: ProjectRef | null, type?: string): SqlFilter {
  const where = ["m.deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (scope === "global") where.push("m.scope = 'global'");
  else if (scope === "project") {
    where.push("m.scope = 'project'", "m.project_key = ?");
    params.push(project?.key ?? "");
  } else if (project) {
    where.push("(m.scope = 'global' OR m.project_key = ?)");
    params.push(project.key);
  }
  if (type) {
    where.push("m.type = ?");
    params.push(type);
  }
  return { where: where.join(" AND "), params };
}

function addRanks(ranks: Map<number, number>, ids: number[]): void {
  for (const [index, id] of ids.entries()) ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + index + 1));
}

// Pinned +10%, recency up to +6% (half-life about a month), project scope +5%.
function boost(row: MemoryRow, nowMs: number): number {
  const ageDays = (nowMs - Date.parse(row.last_seen_at ?? row.updated_at)) / 86_400_000;
  const recency = 0.06 / (1 + Math.max(0, ageDays) / 30);
  return 1 + 0.1 * row.pinned + recency + (row.scope === "project" ? 0.05 : 0);
}

function memoryHit(row: MemoryWithProject, score: number): MemoryHit {
  return {
    kind: "memory",
    id: String(row.id),
    title: row.title,
    type: row.type,
    scope: row.scope,
    projectKey: row.project_key,
    projectName: row.project_name,
    preview: clip(row.content, 240),
    pinned: row.pinned === 1,
    updatedAt: row.updated_at,
    score,
  };
}
