import type { RecordKind } from "../shared/retrieval";
import type { SearchScope } from "../shared/service-api";
import { currentLifecycleSql } from "./lifecycle";

export type Scope = "global" | "project";
export type Operation = "read" | "write" | "delete" | "restore" | "merge";

export interface Namespace {
  scope: Scope;
  projectKey: string | null;
}

export interface SqlFilter {
  where: string;
  params: (string | number)[];
}

// Which project partitions a request may touch. "every" exists only for the owner UI.
export type ProjectReach = { kind: "none" } | { kind: "one"; key: string } | { kind: "every" };

export interface Reach {
  global: boolean;
  projects: ProjectReach;
}

const AGENT_MAY: Record<Operation, boolean> = {
  read: true,
  write: true,
  delete: true,
  restore: false,
  merge: false,
};

/**
 * Who is asking and what they may reach. The owner UI is a separate principal and cannot be built from
 * MCP tool arguments; an agent is limited to global memory plus the project in its signed token.
 */
export class Access {
  readonly kind: "owner" | "agent";
  private readonly projectKey: string | null;

  private constructor(kind: "owner" | "agent", projectKey: string | null) {
    this.kind = kind;
    this.projectKey = projectKey;
  }

  /** The owner sees every namespace. `focusProjectKey` narrows `scope: "all"` to that project plus global. */
  static owner(focusProjectKey: string | null = null): Access {
    return new Access("owner", focusProjectKey);
  }

  /** `projectKey` null means the project could not be resolved: only global memory is granted. */
  static agent(projectKey: string | null): Access {
    return new Access("agent", projectKey);
  }

  allows(operation: Operation, namespace: Namespace): boolean {
    if (this.kind === "owner") return true;
    if (!AGENT_MAY[operation]) return false;
    if (namespace.scope === "global") return true;
    return this.projectKey !== null && namespace.projectKey === this.projectKey;
  }

  reach(scope: SearchScope): Reach {
    const granted: ProjectReach = this.projectKey ? { kind: "one", key: this.projectKey } : { kind: "none" };
    if (scope === "global") return { global: true, projects: { kind: "none" } };
    if (scope === "project") return { global: false, projects: granted };
    if (this.kind === "owner" && !this.projectKey) return { global: true, projects: { kind: "every" } };
    return { global: true, projects: granted };
  }

  /** SQL over `memories m` for the namespaces `scope` resolves to. */
  memoryFilter(scope: SearchScope, type?: string, at?: string, recordKinds?: RecordKind[]): SqlFilter {
    const where = ["m.deleted_at IS NULL", currentLifecycleSql("m", at ? "?" : undefined)];
    const params: (string | number)[] = [];
    if (at) params.push(at);
    const { global, projects } = this.reach(scope);
    const parts: string[] = [];
    if (global) parts.push("m.scope = 'global'");
    if (projects.kind === "one") {
      parts.push("(m.scope = 'project' AND m.project_key = ?)");
      params.push(projects.key);
    } else if (projects.kind === "every") parts.push("m.scope = 'project'");
    where.push(parts.length > 0 ? `(${parts.join(" OR ")})` : "0");
    if (type) {
      where.push("m.type = ?");
      params.push(type);
    }
    if (recordKinds) {
      where.push(recordKinds.length ? `m.record_kind IN (${recordKinds.map(() => "?").join(",")})` : "0");
      params.push(...recordKinds);
    }
    return { where: where.join(" AND "), params };
  }

  /** SQL over `sessions s`; sessions are always project-scoped, so `global` reaches none. */
  sessionFilter(scope: SearchScope): SqlFilter | null {
    const { projects } = this.reach(scope);
    if (projects.kind === "none") return null;
    const current = `NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE
      (t.kind='session' AND t.identifier=s.agent_id)
      OR (t.kind='caller' AND t.identifier IN (SELECT nonce FROM agent_links WHERE agent_id=s.agent_id)))`;
    if (projects.kind === "every") return { where: current, params: [] };
    return { where: `s.project_key = ? AND ${current}`, params: [projects.key] };
  }
}

// "unchanged" means the request was allowed but would not have altered the memory.
export type MutationOutcome = "ok" | "unchanged" | "not_found" | "denied";

// The revisions are the ones the caller looked at; the merge is refused if either memory changed since.
export interface MergeRequest {
  sourceId: number;
  targetId: number;
  sourceRevision: number;
  targetRevision: number;
}

export interface MergeResult {
  ok: boolean;
  message: string;
  mergeId?: number;
  /** True when a memory changed after the caller read it; the merge was not applied. */
  conflict?: boolean;
}
