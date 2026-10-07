import type { Database } from "bun:sqlite";
import type { ProjectRef, SearchScope } from "../shared/service-api";
import { isUsableReply } from "../shared/turns";
import { redact } from "./redact";
import { clip, ftsQuery, RRF_K } from "./text";

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

export interface TurnInput {
  agentId: string;
  project: ProjectRef | null;
  provider: string | null;
  title: string | null;
  workspaceDir: string | null;
  userText: string | null;
  assistantText: string | null;
  files: string[];
}

export interface SessionHit {
  kind: "session";
  id: string;
  title: string;
  type: "session";
  scope: "project";
  projectKey: string | null;
  projectName: string | null;
  preview: string;
  pinned: false;
  updatedAt: string;
  score: number;
}

export function recordTurn(db: Database, input: TurnInput, ts: string): boolean {
  if (!isUsableReply(input.assistantText)) return false;
  const userText = input.userText ? clip(redact(input.userText), 1500) : null;
  const reply = clip(redact(input.assistantText), 2500);
  const existing = db.query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ?`).get(input.agentId);
  if (!existing) {
    db.query(
      `INSERT INTO sessions (id, project_key, agent_id, provider, title, workspace_dir, first_prompt,
        last_prompt, last_reply, files, turns, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
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
    return true;
  }
  const files = new Set<string>([...(JSON.parse(existing.files) as string[]), ...input.files]);
  db.query(
    `UPDATE sessions SET title = coalesce(?, title), last_prompt = coalesce(?, last_prompt),
     last_reply = coalesce(?, last_reply), files = ?, turns = turns + 1, updated_at = ?,
     project_key = coalesce(project_key, ?) WHERE id = ?`,
  ).run(
    input.title,
    userText,
    reply,
    JSON.stringify([...files].slice(-50)),
    ts,
    input.project?.key ?? null,
    input.agentId,
  );
  return true;
}

export function listSessions(
  db: Database,
  input: { projectKey: string | null; query: string; limit: number },
): SessionRow[] {
  const fts = ftsQuery(input.query);
  if (!fts) {
    return db
      .query<SessionRow, [string, number]>(
        `SELECT * FROM sessions WHERE ifnull(project_key, '') = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(input.projectKey ?? "", input.limit);
  }
  return db
    .query<SessionRow, [string, string, number]>(
      `SELECT s.* FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
       WHERE sessions_fts MATCH ? AND ifnull(s.project_key, '') = ? ORDER BY bm25(sessions_fts) LIMIT ?`,
    )
    .all(fts, input.projectKey ?? "", input.limit);
}

export function searchSessions(
  db: Database,
  input: { query: string; project: ProjectRef | null; scope: SearchScope; limit: number },
): SessionHit[] {
  const fts = ftsQuery(input.query);
  if (input.scope === "global" || !fts) return [];
  const params: (string | number)[] = [fts];
  let where = "";
  if (input.scope === "project" || input.project) {
    where = "AND ifnull(s.project_key, '') = ?";
    params.push(input.project?.key ?? "");
  }
  const rows = db
    .query<SessionRow & { project_name: string | null }, (string | number)[]>(
      `SELECT s.*, p.name AS project_name FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
       LEFT JOIN projects p ON p.key = s.project_key
       WHERE sessions_fts MATCH ? ${where} ORDER BY bm25(sessions_fts) LIMIT ?`,
    )
    .all(...params, input.limit);
  return rows.map((row, index) => ({
    kind: "session",
    id: row.id,
    title: row.title ?? clip(row.first_prompt ?? "session", 80),
    type: "session",
    scope: "project",
    projectKey: row.project_key,
    projectName: row.project_name,
    preview: clip(row.last_reply ?? row.last_prompt ?? "", 240),
    pinned: false,
    updatedAt: row.updated_at,
    score: 0.5 / (RRF_K + index + 1),
  }));
}
