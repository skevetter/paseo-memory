// Single-file SQLite memory store: memories (global + project scope), session digests,
// FTS5 keyword search, optional vector search (brute-force cosine over BLOBs, or sqlite-vec
// when the extension loads), and reciprocal-rank fusion.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import { type Embedder, cosine, fromBlob, toBlob } from "./embedder";
import { redact } from "./redact";

export type Scope = "global" | "project";
export type SearchScope = "all" | "project" | "global";

export interface ProjectRef {
  key: string; // stable across worktrees, re-adds and hosts (Paseo projectKey or root path)
  name: string;
  rootPath: string | null;
  paseoProjectId: string | null;
}

export interface MemoryRow {
  id: number;
  scope: Scope;
  project_key: string | null;
  type: string;
  title: string;
  content: string;
  topic_key: string | null;
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

export interface SessionRow {
  id: string;
  project_key: string | null;
  agent_id: string;
  provider: string | null;
  title: string | null;
  workspace_dir: string | null;
  first_prompt: string | null;
  last_prompt: string | null;
  last_reply: string | null;
  files: string;
  turns: number;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

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

export interface SearchHit {
  kind: "memory" | "session";
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

export interface SearchInput {
  query: string;
  project: ProjectRef | null;
  scope?: SearchScope;
  type?: string;
  limit?: number;
  includeSessions?: boolean;
}

export interface StoreOptions {
  path: string;
  embedder?: Embedder | null;
  sqliteVecPath?: string | null;
  duplicateThreshold?: number;
  now?: () => Date;
}

const SCHEMA_VERSION = 1;
const RRF_K = 60;

export class MemoryStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;
  private embedder: Embedder | null;
  private readonly duplicateThreshold: number;
  private readonly now: () => Date;
  private vecTable: string | null = null;
  vectorIndex: "off" | "blob" | "sqlite-vec" = "off";

  constructor(options: StoreOptions) {
    this.path = options.path;
    this.embedder = options.embedder ?? null;
    this.duplicateThreshold = options.duplicateThreshold ?? 0.92;
    this.now = options.now ?? (() => new Date());
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(options.path, { allowExtension: Boolean(options.sqliteVecPath) });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    this.migrate();
    if (options.sqliteVecPath) this.tryLoadSqliteVec(options.sqliteVecPath);
    this.setEmbedder(this.embedder);
  }

  close(): void {
    this.db.close();
  }

  setEmbedder(embedder: Embedder | null): void {
    this.embedder = embedder;
    if (!embedder) {
      this.vectorIndex = "off";
      return;
    }
    this.setMeta("embedding_model", embedder.model);
    this.setMeta("embedding_dims", String(embedder.dims));
    if (this.vecTable === null && this.vectorIndex !== "sqlite-vec") this.vectorIndex = "blob";
    this.ensureVecTable(embedder.dims);
    this.backfillEmbeddings();
  }

  // ---------- projects ----------

  upsertProject(project: ProjectRef): void {
    const ts = this.ts();
    this.db
      .prepare(
        `INSERT INTO projects (key, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name,
           root_path = coalesce(excluded.root_path, projects.root_path), updated_at = excluded.updated_at`,
      )
      .run(project.key, project.name, project.rootPath, ts, ts);
    if (project.paseoProjectId) {
      this.db
        .prepare(
          `INSERT INTO project_aliases (paseo_project_id, project_key, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(paseo_project_id) DO UPDATE SET project_key = excluded.project_key, updated_at = excluded.updated_at`,
        )
        .run(project.paseoProjectId, project.key, ts);
    }
  }

  projectByPaseoId(paseoProjectId: string): ProjectRef | null {
    const row = this.db
      .prepare(
        `SELECT p.key, p.name, p.root_path FROM project_aliases a JOIN projects p ON p.key = a.project_key
         WHERE a.paseo_project_id = ?`,
      )
      .get(paseoProjectId) as { key: string; name: string; root_path: string | null } | undefined;
    return row ? { key: row.key, name: row.name, rootPath: row.root_path, paseoProjectId } : null;
  }

  // ---------- memories ----------

  save(input: SaveInput): SaveResult {
    const title = redact(input.title).trim().slice(0, 200);
    const content = redact(input.content).trim();
    if (!title || !content) throw new Error("title and content are required");
    const scope: Scope = input.scope === "project" && input.project ? "project" : "global";
    const projectKey = scope === "project" ? (input.project?.key ?? null) : null;
    if (input.project) this.upsertProject(input.project);
    const ts = this.ts();
    const hash = sha256(`${input.type}\n${title}\n${content}`);
    const topicKey = input.topicKey?.trim() || null;

    if (topicKey) {
      const existing = this.db
        .prepare(
          `SELECT * FROM memories WHERE scope = ? AND ifnull(project_key, '') = ? AND topic_key = ?
           AND deleted_at IS NULL`,
        )
        .get(scope, projectKey ?? "", topicKey) as MemoryRow | undefined;
      if (existing) {
        this.snapshot(existing);
        this.db
          .prepare(
            `UPDATE memories SET title = ?, content = ?, type = ?, content_hash = ?, pinned = max(pinned, ?),
             revision_count = revision_count + 1, updated_at = ?, agent_id = coalesce(?, agent_id),
             provider = coalesce(?, provider), workspace_dir = coalesce(?, workspace_dir) WHERE id = ?`,
          )
          .run(
            title,
            content,
            input.type,
            hash,
            input.pinned ? 1 : 0,
            ts,
            input.agentId ?? null,
            input.provider ?? null,
            input.workspaceDir ?? null,
            existing.id,
          );
        this.indexEmbedding(existing.id, title, content, scope, projectKey);
        return { status: "updated", id: existing.id };
      }
    }

    const sameHash = this.db
      .prepare(
        `SELECT id FROM memories WHERE content_hash = ? AND scope = ? AND ifnull(project_key, '') = ?
         AND deleted_at IS NULL`,
      )
      .get(hash, scope, projectKey ?? "") as { id: number } | undefined;
    if (sameHash) {
      this.db
        .prepare(`UPDATE memories SET duplicate_count = duplicate_count + 1, last_seen_at = ? WHERE id = ?`)
        .run(ts, sameHash.id);
      return { status: "duplicate", id: sameHash.id };
    }

    let vector: Float32Array | null = null;
    if (this.embedder) {
      vector = this.embedder.embed(`${title}\n${content}`);
      if (!input.force && !topicKey) {
        const near = this.nearest(vector, scope, projectKey, 3).filter(
          (n) => n.similarity >= this.duplicateThreshold,
        );
        if (near.length > 0) return { status: "possible_duplicate", id: null, candidates: near };
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO memories (scope, project_key, type, title, content, topic_key, content_hash, pinned,
          source, agent_id, provider, workspace_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope,
        projectKey,
        input.type,
        title,
        content,
        topicKey,
        hash,
        input.pinned ? 1 : 0,
        input.source ?? "agent",
        input.agentId ?? null,
        input.provider ?? null,
        input.workspaceDir ?? null,
        ts,
        ts,
      );
    const id = Number(result.lastInsertRowid);
    if (vector) this.writeEmbedding(id, vector, scope, projectKey);
    return { status: "created", id };
  }

  get(ids: number[]): (MemoryRow & { project_name: string | null })[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE m.id IN (${ids.map(() => "?").join(",")}) AND m.deleted_at IS NULL`,
      )
      .all(...ids) as unknown as (MemoryRow & { project_name: string | null })[];
    const ts = this.ts();
    const touch = this.db.prepare(`UPDATE memories SET last_seen_at = ? WHERE id = ?`);
    for (const row of rows) touch.run(ts, row.id);
    return rows;
  }

  update(
    id: number,
    patch: { title?: string; content?: string; type?: string; pinned?: boolean; topicKey?: string | null },
  ): boolean {
    const existing = this.db
      .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as MemoryRow | undefined;
    if (!existing) return false;
    const textChanged = patch.title !== undefined || patch.content !== undefined;
    if (textChanged) this.snapshot(existing);
    const title = patch.title !== undefined ? redact(patch.title).trim() : existing.title;
    const content = patch.content !== undefined ? redact(patch.content).trim() : existing.content;
    const type = patch.type ?? existing.type;
    this.db
      .prepare(
        `UPDATE memories SET title = ?, content = ?, type = ?, pinned = ?, topic_key = ?, content_hash = ?,
         revision_count = revision_count + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        title,
        content,
        type,
        patch.pinned === undefined ? existing.pinned : patch.pinned ? 1 : 0,
        patch.topicKey === undefined ? existing.topic_key : patch.topicKey,
        sha256(`${type}\n${title}\n${content}`),
        textChanged ? 1 : 0,
        this.ts(),
        id,
      );
    if (textChanged) this.indexEmbedding(id, title, content, existing.scope, existing.project_key);
    return true;
  }

  delete(id: number, hard = false): boolean {
    if (hard) {
      this.db.prepare(`DELETE FROM memory_embeddings WHERE memory_id = ?`).run(id);
      if (this.vecTable) this.db.prepare(`DELETE FROM ${this.vecTable} WHERE memory_id = ?`).run(BigInt(id));
      return this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes > 0;
    }
    const changed = this.db
      .prepare(`UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(this.ts(), id).changes;
    if (changed && this.vecTable) this.db.prepare(`DELETE FROM ${this.vecTable} WHERE memory_id = ?`).run(BigInt(id));
    return changed > 0;
  }

  list(input: { project: ProjectRef | null; scope?: SearchScope; limit?: number; pinnedOnly?: boolean }): SearchHit[] {
    const where = ["m.deleted_at IS NULL", ...this.scopeClause(input.scope ?? "all", input.project)];
    const params: (string | number)[] = this.scopeParams(input.scope ?? "all", input.project);
    if (input.pinnedOnly) where.push("m.pinned = 1");
    const rows = this.db
      .prepare(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE ${where.join(" AND ")} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(...params, input.limit ?? 50) as unknown as (MemoryRow & { project_name: string | null })[];
    return rows.map((row) => memoryHit(row, 0));
  }

  search(input: SearchInput): SearchHit[] {
    const scope = input.scope ?? "all";
    const limit = input.limit ?? 8;
    const query = input.query.trim();
    if (!query) return this.list({ project: input.project, scope, limit });

    const ranks = new Map<number, number>();
    const add = (ids: number[]) => {
      ids.forEach((id, index) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
    };

    const where = ["m.deleted_at IS NULL", ...this.scopeClause(scope, input.project)];
    const params: (string | number)[] = this.scopeParams(scope, input.project);
    if (input.type) {
      where.push("m.type = ?");
      params.push(input.type);
    }

    const fts = ftsQuery(query);
    if (fts) {
      const ftsIds = this.db
        .prepare(
          `SELECT m.id FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND ${where.join(" AND ")}
           ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0) LIMIT 50`,
        )
        .all(fts, ...params) as { id: number }[];
      add(ftsIds.map((r) => r.id));
    }
    if (query.length < 3 || ranks.size === 0) {
      const like = `%${query.replace(/[%_]/g, "")}%`;
      const likeIds = this.db
        .prepare(
          `SELECT m.id FROM memories m WHERE (m.title LIKE ? OR m.content LIKE ? OR m.topic_key LIKE ?)
           AND ${where.join(" AND ")} ORDER BY m.updated_at DESC LIMIT 20`,
        )
        .all(like, like, like, ...params) as { id: number }[];
      add(likeIds.map((r) => r.id));
    }

    if (this.embedder) {
      const vector = this.embedder.embed(query);
      const near = this.nearestForSearch(vector, scope, input.project, input.type);
      // Static-embedding cosine scores run low; keep hits relative to the best match.
      const floor = Math.max(0.12, (near[0]?.similarity ?? 0) * 0.5);
      add(near.filter((n) => n.similarity >= floor).slice(0, 20).map((n) => n.id));
    }

    const ids = [...ranks.keys()];
    const rows = ids.length
      ? (this.db
          .prepare(
            `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
             WHERE m.id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as unknown as (MemoryRow & { project_name: string | null })[])
      : [];
    const nowMs = this.now().getTime();
    const hits = rows.map((row) => {
      const base = ranks.get(row.id) ?? 0;
      const ageDays = (nowMs - Date.parse(row.last_seen_at ?? row.updated_at)) / 86_400_000;
      const boost = 1 + 0.1 * row.pinned + 0.06 / (1 + Math.max(0, ageDays) / 30) + (row.scope === "project" ? 0.05 : 0);
      return memoryHit(row, base * boost);
    });

    if (input.includeSessions) hits.push(...this.searchSessions(query, input.project, scope, limit));
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------- sessions (automatic per-agent digest) ----------

  recordTurn(input: {
    agentId: string;
    project: ProjectRef | null;
    provider: string | null;
    title: string | null;
    workspaceDir: string | null;
    userText: string | null;
    assistantText: string | null;
    files: string[];
  }): void {
    if (input.project) this.upsertProject(input.project);
    const ts = this.ts();
    const existing = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(input.agentId) as
      | SessionRow
      | undefined;
    const userText = input.userText ? clip(redact(input.userText), 1500) : null;
    const reply = input.assistantText ? clip(redact(input.assistantText), 2500) : null;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_key, agent_id, provider, title, workspace_dir, first_prompt,
            last_prompt, last_reply, files, turns, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.agentId,
          input.project?.key ?? null,
          input.agentId,
          input.provider,
          input.title,
          input.workspaceDir,
          userText,
          userText,
          reply,
          JSON.stringify(input.files.slice(0, 50)),
          ts,
          ts,
        );
      return;
    }
    const files = new Set<string>([...(JSON.parse(existing.files) as string[]), ...input.files]);
    this.db
      .prepare(
        `UPDATE sessions SET title = coalesce(?, title), last_prompt = coalesce(?, last_prompt),
         last_reply = coalesce(?, last_reply), files = ?, turns = turns + 1, updated_at = ?,
         project_key = coalesce(project_key, ?) WHERE id = ?`,
      )
      .run(
        input.title,
        userText,
        reply,
        JSON.stringify([...files].slice(-50)),
        ts,
        input.project?.key ?? null,
        input.agentId,
      );
  }

  endSession(agentId: string): void {
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(this.ts(), agentId);
  }

  recentSessions(projectKey: string | null, limit: number, excludeAgentId?: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE ifnull(project_key, '') = ? AND id != ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(projectKey ?? "", excludeAgentId ?? "", limit) as unknown as SessionRow[];
  }

  pruneSessions(retentionDays: number): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return Number(this.db.prepare(`DELETE FROM sessions WHERE updated_at < ?`).run(cutoff).changes);
  }

  stats(): { memories: number; sessions: number; projects: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      memories: one(`SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL`),
      sessions: one(`SELECT count(*) AS n FROM sessions`),
      projects: one(`SELECT count(*) AS n FROM projects`),
    };
  }

  // ---------- internals ----------

  private searchSessions(query: string, project: ProjectRef | null, scope: SearchScope, limit: number): SearchHit[] {
    if (scope === "global") return [];
    const fts = ftsQuery(query);
    if (!fts) return [];
    const params: string[] = [fts];
    let where = "";
    if (scope === "project" || project) {
      where = "AND ifnull(s.project_key, '') = ?";
      params.push(project?.key ?? "");
    }
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
         LEFT JOIN projects p ON p.key = s.project_key
         WHERE sessions_fts MATCH ? ${where} ORDER BY bm25(sessions_fts) LIMIT ?`,
      )
      .all(...params, limit) as unknown as (SessionRow & { project_name: string | null })[];
    return rows.map((row, index) => ({
      kind: "session" as const,
      id: row.id,
      title: row.title ?? clip(row.first_prompt ?? "session", 80),
      type: "session",
      scope: "project" as const,
      projectKey: row.project_key,
      projectName: row.project_name,
      preview: clip(row.last_reply ?? row.last_prompt ?? "", 240),
      pinned: false,
      updatedAt: row.updated_at,
      score: 0.5 / (RRF_K + index + 1),
    }));
  }

  private scopeClause(scope: SearchScope, project: ProjectRef | null): string[] {
    if (scope === "global") return ["m.scope = 'global'"];
    if (scope === "project") return ["m.scope = 'project'", "m.project_key = ?"];
    return project ? ["(m.scope = 'global' OR m.project_key = ?)"] : [];
  }

  private scopeParams(scope: SearchScope, project: ProjectRef | null): string[] {
    if (scope === "global") return [];
    if (scope === "project") return [project?.key ?? ""];
    return project ? [project.key] : [];
  }

  private snapshot(row: MemoryRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_versions (memory_id, version, title, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.revision_count, row.title, row.content, row.updated_at);
  }

  private indexEmbedding(id: number, title: string, content: string, scope: Scope, projectKey: string | null): void {
    if (!this.embedder) return;
    this.writeEmbedding(id, this.embedder.embed(`${title}\n${content}`), scope, projectKey);
  }

  private writeEmbedding(id: number, vector: Float32Array, scope: Scope, projectKey: string | null): void {
    if (!this.embedder) return;
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, model, dims, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector`,
      )
      .run(id, this.embedder.model, vector.length, toBlob(vector));
    if (this.vecTable) {
      this.db.prepare(`DELETE FROM ${this.vecTable} WHERE memory_id = ?`).run(BigInt(id));
      this.db
        .prepare(`INSERT INTO ${this.vecTable} (memory_id, scope_key, embedding) VALUES (?, ?, ?)`)
        .run(BigInt(id), scopeKey(scope, projectKey), toBlob(vector));
    }
  }

  private nearest(
    vector: Float32Array,
    scope: Scope,
    projectKey: string | null,
    k: number,
  ): { id: number; title: string; similarity: number }[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.title, e.vector FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.deleted_at IS NULL AND m.scope = ? AND ifnull(m.project_key, '') = ? AND e.model = ?`,
      )
      .all(scope, projectKey ?? "", this.embedder?.model ?? "") as { id: number; title: string; vector: Uint8Array }[];
    return rows
      .map((r) => ({ id: r.id, title: r.title, similarity: round(cosine(vector, fromBlob(r.vector))) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  private nearestForSearch(
    vector: Float32Array,
    scope: SearchScope,
    project: ProjectRef | null,
    type?: string,
  ): { id: number; similarity: number }[] {
    if (this.vecTable) {
      const keys: string[] = [];
      if (scope !== "project") keys.push(scopeKey("global", null));
      if (scope !== "global" && project) keys.push(scopeKey("project", project.key));
      const out: { id: number; similarity: number }[] = [];
      const stmt = this.db.prepare(
        `SELECT memory_id, distance FROM ${this.vecTable} WHERE embedding MATCH ? AND k = 50 AND scope_key = ?`,
      );
      for (const key of keys) {
        for (const row of stmt.all(toBlob(vector), key) as { memory_id: number | bigint; distance: number }[]) {
          out.push({ id: Number(row.memory_id), similarity: 1 - row.distance });
        }
      }
      const filtered = type ? this.filterType(out, type) : out;
      return filtered.sort((a, b) => b.similarity - a.similarity).slice(0, 50);
    }
    const where = ["m.deleted_at IS NULL", "e.model = ?", ...this.scopeClause(scope, project)];
    const params: string[] = [this.embedder?.model ?? "", ...this.scopeParams(scope, project)];
    if (type) {
      where.push("m.type = ?");
      params.push(type);
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, e.vector FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id WHERE ${where.join(" AND ")}`,
      )
      .all(...params) as { id: number; vector: Uint8Array }[];
    return rows
      .map((r) => ({ id: r.id, similarity: cosine(vector, fromBlob(r.vector)) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 50);
  }

  private filterType(items: { id: number; similarity: number }[], type: string) {
    if (items.length === 0) return items;
    const ok = new Set(
      (
        this.db
          .prepare(`SELECT id FROM memories WHERE type = ? AND id IN (${items.map(() => "?").join(",")})`)
          .all(type, ...items.map((i) => i.id)) as { id: number }[]
      ).map((r) => r.id),
    );
    return items.filter((i) => ok.has(i.id));
  }

  private backfillEmbeddings(): void {
    if (!this.embedder) return;
    const rows = this.db
      .prepare(
        `SELECT m.id, m.title, m.content, m.scope, m.project_key FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
         WHERE m.deleted_at IS NULL AND e.memory_id IS NULL`,
      )
      .all(this.embedder.model) as { id: number; title: string; content: string; scope: Scope; project_key: string | null }[];
    for (const row of rows) this.indexEmbedding(row.id, row.title, row.content, row.scope, row.project_key);
  }

  private tryLoadSqliteVec(path: string): void {
    try {
      this.db.loadExtension(path);
      this.vectorIndex = "sqlite-vec";
      this.vecTable = "pending";
    } catch {
      this.vecTable = null;
    }
  }

  private ensureVecTable(dims: number): void {
    if (this.vecTable === null) return;
    const name = `memories_vec_${dims}`;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(memory_id INTEGER PRIMARY KEY,
          scope_key TEXT PARTITION KEY, embedding FLOAT[${dims}] distance_metric=cosine)`,
      );
      this.vecTable = name;
      this.vectorIndex = "sqlite-vec";
      const missing = this.db
        .prepare(
          `SELECT m.id, m.scope, m.project_key, e.vector FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
           WHERE m.deleted_at IS NULL AND e.dims = ? AND m.id NOT IN (SELECT memory_id FROM ${name})`,
        )
        .all(dims) as { id: number; scope: Scope; project_key: string | null; vector: Uint8Array }[];
      const insert = this.db.prepare(`INSERT INTO ${name} (memory_id, scope_key, embedding) VALUES (?, ?, ?)`);
      for (const row of missing) insert.run(BigInt(row.id), scopeKey(row.scope, row.project_key), row.vector);
    } catch {
      this.vecTable = null;
      this.vectorIndex = "blob";
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private migrate(): void {
    const current = Number(
      (this.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version,
    );
    if (current >= SCHEMA_VERSION) return;
    this.db.exec(`
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
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
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
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}

// ---------- helpers ----------

type SqliteModule = typeof import("node:sqlite");

function loadSqlite(): SqliteModule {
  const mod = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  if (!mod || typeof mod.DatabaseSync !== "function") throw new Error("node:sqlite is not available in this runtime");
  return mod;
}

export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .match(/[\p{L}\p{N}_\-./]+/gu)
    ?.map((t) => t.replace(/^[-./]+|[-./]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens || tokens.length === 0) return null;
  return [...new Set(tokens)].slice(0, 16).map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from how i in is it of on or our so that the this to was we what when where which who why with you".split(
    " ",
  ),
);

function memoryHit(row: MemoryRow & { project_name: string | null }, score: number): SearchHit {
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

function scopeKey(scope: Scope, projectKey: string | null): string {
  return scope === "global" ? "global" : `project:${sha256(projectKey ?? "").slice(0, 16)}`;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type { StatementSync };
