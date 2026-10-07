// Per-agent audit of what memory did: the block injected at agent.create and every tool call.
// Rows hold ids, scores and statuses, never memory content. Each agent's token carries a random
// nonce; agent_links maps it to the Paseo agent id once the plugin reports the link.

import type { Database } from "bun:sqlite";
import type { AgentAudit, AuditEvent, AuditKind, WorkspaceAgent } from "../shared/service-api";
import { redact } from "./redact";
import { clip } from "./text";

export interface Injection {
  memories: number[];
  sessions: string[];
  chars: number;
  budget: number;
}

// Search results are memory ids ("12") or session ids ("session:<agent id>").
export type AuditDetail =
  | ({ kind: "inject" | "context" } & Injection)
  | { kind: "search"; query: string; scope: string; results: { id: string; score: number }[] }
  | { kind: "get"; ids: number[]; found: number[] }
  | { kind: "save"; id: number | null; status: string; candidates: number[] }
  | { kind: "update" | "delete"; id: number; ok: boolean };

interface LinkRow {
  nonce: string;
  agent_id: string | null;
  workspace_id: string | null;
  project_key: string | null;
  provider: string | null;
  title: string | null;
  created_at: string;
  linked_at: string | null;
}

interface EventRow {
  id: number;
  kind: AuditKind;
  detail: string;
  created_at: string;
}

export class AuditLog {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, now: () => string) {
    this.db = db;
    this.now = now;
  }

  // A link row exists from agent.create on; the agent id arrives later.
  open(input: { nonce: string; projectKey: string | null; provider: string | null }): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO agent_links (nonce, project_key, provider, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.nonce, input.projectKey, input.provider, this.now());
  }

  link(input: { nonce: string; agentId: string; workspaceId: string | null; title: string | null }): void {
    const ts = this.now();
    this.db
      .query(
        `INSERT INTO agent_links (nonce, agent_id, workspace_id, title, created_at, linked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(nonce) DO UPDATE SET agent_id = excluded.agent_id,
           workspace_id = coalesce(excluded.workspace_id, agent_links.workspace_id),
           title = coalesce(excluded.title, agent_links.title), linked_at = excluded.linked_at`,
      )
      .run(input.nonce, input.agentId, input.workspaceId, input.title, ts, ts);
  }

  agentFor(nonce: string): string | null {
    return (
      this.db
        .query<{ agent_id: string | null }, [string]>(`SELECT agent_id FROM agent_links WHERE nonce = ?`)
        .get(nonce)?.agent_id ?? null
    );
  }

  retitle(agentId: string, title: string | null): void {
    if (!title) return;
    this.db.query(`UPDATE agent_links SET title = ? WHERE agent_id = ?`).run(title, agentId);
  }

  record(nonce: string | null, detail: AuditDetail): void {
    if (!nonce) return;
    const { kind, ...rest } = detail;
    const stored = "query" in rest ? { ...rest, query: clip(redact(rest.query), 200) } : rest;
    this.db
      .query(`INSERT INTO audit_events (nonce, kind, detail, created_at) VALUES (?, ?, ?, ?)`)
      .run(nonce, kind, JSON.stringify(stored), this.now());
  }

  // Events older than the cutoff go, and so do links that no longer have events.
  prune(cutoff: string): number {
    const events = this.db.query(`DELETE FROM audit_events WHERE created_at < ? RETURNING id`).all(cutoff);
    this.db
      .query(
        `DELETE FROM agent_links WHERE created_at < ? AND nonce NOT IN (SELECT DISTINCT nonce FROM audit_events)`,
      )
      .run(cutoff);
    return events.length;
  }

  workspaceAgents(workspaceId: string, limit: number): WorkspaceAgent[] {
    return this.db
      .query<
        {
          agent_id: string;
          title: string | null;
          provider: string | null;
          created_at: string;
          last: string | null;
          n: number;
        },
        [string, number]
      >(
        `SELECT l.agent_id, max(l.title) AS title, max(l.provider) AS provider, min(l.created_at) AS created_at,
           max(e.created_at) AS last, count(e.id) AS n
         FROM agent_links l LEFT JOIN audit_events e ON e.nonce = l.nonce
         WHERE l.workspace_id = ? AND l.agent_id IS NOT NULL
         GROUP BY l.agent_id ORDER BY coalesce(max(e.created_at), min(l.created_at)) DESC LIMIT ?`,
      )
      .all(workspaceId, limit)
      .map((r) => ({
        agentId: r.agent_id,
        title: r.title,
        provider: r.provider,
        createdAt: r.created_at,
        lastEventAt: r.last,
        events: r.n,
      }));
  }

  agent(agentId: string): AgentAudit {
    const links = this.db
      .query<LinkRow, [string]>(`SELECT * FROM agent_links WHERE agent_id = ? ORDER BY created_at`)
      .all(agentId);
    const first = links[0];
    const rows = this.db
      .prepare<EventRow, string[]>(
        `SELECT id, kind, detail, created_at FROM audit_events
         WHERE nonce IN (${links.map(() => "?").join(",") || "''"}) ORDER BY id`,
      )
      .all(...links.map((l) => l.nonce));
    const views = new AuditViews(this.db, rows);
    const inject = rows.find((r) => r.kind === "inject");
    return {
      agentId,
      linked: links.length > 0,
      provider: first?.provider ?? null,
      title: links.find((l) => l.title)?.title ?? null,
      projectName: first?.project_key ? views.projectName(first.project_key) : null,
      createdAt: first?.created_at ?? null,
      injected: inject ? views.injection(inject) : null,
      events: rows.filter((r) => r.kind !== "inject").map((r) => views.event(r)),
    };
  }
}

// Turns stored event rows into views, reading memory and session titles in two queries.
class AuditViews {
  private readonly db: Database;
  private readonly memoryTitles: Map<number, string>;
  private readonly sessionTitles: Map<string, string | null>;

  constructor(db: Database, rows: EventRow[]) {
    this.db = db;
    const details = rows.map((r) => ({ kind: r.kind, ...JSON.parse(r.detail) }) as AuditDetail);
    this.memoryTitles = this.loadMemoryTitles(details.flatMap(memoryIds));
    this.sessionTitles = this.loadSessionTitles(details.flatMap(sessionIds));
  }

  projectName(key: string): string | null {
    return (
      this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE key = ?`).get(key)?.name ??
      null
    );
  }

  injection(row: EventRow): NonNullable<AgentAudit["injected"]> {
    const detail = JSON.parse(row.detail) as Injection;
    return {
      memories: detail.memories.map((id) => this.memory(id, null, null)),
      sessions: detail.sessions.map((id) => this.session(id)),
      chars: detail.chars,
      budget: detail.budget,
    };
  }

  event(row: EventRow): AuditEvent {
    const detail = { kind: row.kind, ...JSON.parse(row.detail) } as AuditDetail;
    const base = { id: row.id, kind: row.kind, at: row.created_at, query: null, memories: [], sessions: [] };
    return { ...base, ...this.describe(detail) };
  }

  private describe(d: AuditDetail): Pick<AuditEvent, "summary"> & Partial<AuditEvent> {
    switch (d.kind) {
      case "inject":
      case "context":
        return {
          summary: `${d.memories.length} memories and ${d.sessions.length} sessions, ${d.chars} of ${d.budget} characters`,
          memories: d.memories.map((id) => this.memory(id, null, null)),
          sessions: d.sessions.map((id) => this.session(id)),
        };
      case "search":
        return this.searchView(d);
      case "get":
        return {
          summary: `${d.found.length} of ${d.ids.length} found`,
          memories: d.ids.map((id) => this.memory(id, null, d.found.includes(id) ? "found" : "missing")),
        };
      case "save":
        return this.saveView(d);
      default:
        return {
          summary: `${d.ok ? `${d.kind}d` : "not found"} #${d.id}`,
          memories: [this.memory(d.id, null, d.ok ? `${d.kind}d` : "missing")],
        };
    }
  }

  private saveView(d: Extract<AuditDetail, { kind: "save" }>): Partial<AuditEvent> & { summary: string } {
    const ids = d.id === null ? d.candidates : [d.id, ...d.candidates.filter((c) => c !== d.id)];
    return {
      summary: d.id === null ? d.status : `${d.status} #${d.id}`,
      memories: ids.map((id) => this.memory(id, null, id === d.id ? d.status : "similar")),
    };
  }

  private searchView(d: Extract<AuditDetail, { kind: "search" }>): Partial<AuditEvent> & { summary: string } {
    const memories = d.results.filter((r) => !r.id.startsWith("session:"));
    const sessions = d.results.filter((r) => r.id.startsWith("session:"));
    return {
      query: d.query,
      summary:
        d.results.length === 0
          ? "no results"
          : `${d.results.length} ${d.results.length === 1 ? "result" : "results"} (${d.scope})`,
      memories: memories.map((r) => this.memory(Number(r.id), r.score, null)),
      sessions: sessions.map((r) => this.session(r.id.slice(8))),
    };
  }

  private memory(id: number, score: number | null, status: string | null) {
    return { id, title: this.memoryTitles.get(id) ?? null, score, status };
  }

  private session(id: string) {
    return { id, title: this.sessionTitles.get(id) ?? null };
  }

  private loadMemoryTitles(ids: number[]): Map<number, string> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = this.db
      .prepare<{ id: number; title: string }, number[]>(
        `SELECT id, title FROM memories WHERE deleted_at IS NULL AND id IN (${unique.map(() => "?").join(",")})`,
      )
      .all(...unique);
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  private loadSessionTitles(ids: string[]): Map<string, string | null> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = this.db
      .prepare<{ id: string; title: string | null; first_prompt: string | null }, string[]>(
        `SELECT id, title, first_prompt FROM sessions WHERE id IN (${unique.map(() => "?").join(",")})`,
      )
      .all(...unique);
    return new Map(rows.map((r) => [r.id, r.title ?? (r.first_prompt ? clip(r.first_prompt, 80) : null)]));
  }
}

function memoryIds(d: AuditDetail): number[] {
  switch (d.kind) {
    case "inject":
    case "context":
      return d.memories;
    case "search":
      return d.results.filter((r) => !r.id.startsWith("session:")).map((r) => Number(r.id));
    case "get":
      return d.ids;
    case "save":
      return [...(d.id === null ? [] : [d.id]), ...d.candidates];
    default:
      return [d.id];
  }
}

function sessionIds(d: AuditDetail): string[] {
  if (d.kind === "inject" || d.kind === "context") return d.sessions;
  if (d.kind === "search")
    return d.results.filter((r) => r.id.startsWith("session:")).map((r) => r.id.slice(8));
  return [];
}
