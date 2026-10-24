import { type MemoryNamespace, namespaceKey } from "../shared/namespaces";
import type { RecordKind } from "../shared/retrieval";
import type { SearchScope } from "../shared/service-api";
import { currentLifecycleSql } from "./lifecycle";

export type Operation = "read" | "write" | "delete" | "restore" | "merge";
export type NamespaceGrants = Partial<Readonly<Record<Operation, readonly MemoryNamespace[]>>>;

export interface SqlFilter {
  where: string;
  params: (string | number)[];
}

// Unbounded reach belongs to the owner UI; registered consumers receive explicit namespace sets.
export type NamespaceReach = { kind: "none" } | { kind: "some"; keys: readonly string[] } | { kind: "every" };

export interface Reach {
  global: boolean;
  projects: NamespaceReach;
  bots: NamespaceReach;
}

const AGENT_MAY: Record<Operation, boolean> = {
  read: true,
  write: true,
  delete: true,
  restore: false,
  merge: false,
};

/** Owner UI, standalone agents and registered scoped callers share the same namespace boundary. */
export class Access {
  readonly kind: "owner" | "agent";
  private readonly projectKey: string | null;
  private readonly operationKeys: ReadonlyMap<Operation, ReadonlySet<string>> | null;
  private readonly granted: Reach;

  private constructor(kind: "owner" | "agent", projectKey: string | null, grants: NamespaceGrants | null) {
    this.kind = kind;
    this.projectKey = projectKey;
    this.operationKeys = grants === null ? null : grantKeys(grants);
    this.granted = grants === null ? standaloneReach(kind, projectKey) : namespaceReach(grants.read ?? []);
  }

  /** A focused owner query reaches that project and global, not unrelated bot namespaces. */
  static owner(focusProjectKey: string | null = null): Access {
    return new Access("owner", focusProjectKey, null);
  }

  /** Standalone agents retain global plus their signed project, never an implicit bot grant. */
  static agent(projectKey: string | null): Access {
    return new Access("agent", projectKey, null);
  }

  /** Caller authentication must supply these grants; tool arguments cannot construct them. */
  static scoped(grants: NamespaceGrants): Access {
    return new Access("agent", null, grants);
  }

  get isScoped(): boolean {
    return this.operationKeys !== null;
  }

  allows(operation: Operation, namespace: MemoryNamespace | null): boolean {
    if (namespace === null) return false;
    if (this.kind === "owner") return true;
    if (this.operationKeys !== null)
      return this.operationKeys.get(operation)?.has(namespaceKey(namespace)) ?? false;
    if (!AGENT_MAY[operation]) return false;
    if (namespace.kind === "global") return true;
    return (
      namespace.kind === "project" && this.projectKey !== null && namespace.projectKey === this.projectKey
    );
  }

  reach(scope: SearchScope): Reach {
    if (scope === "all") return this.granted;
    return {
      global: scope === "global" && this.granted.global,
      projects: scope === "project" ? this.granted.projects : { kind: "none" },
      bots: scope === "bot" ? this.granted.bots : { kind: "none" },
    };
  }

  /** SQL over memories m: namespace and lifecycle filtering precede materialization and inference. */
  memoryFilter(scope: SearchScope, type?: string, at?: string, recordKinds?: RecordKind[]): SqlFilter {
    const where = ["m.deleted_at IS NULL", currentLifecycleSql("m", at ? "?" : undefined)];
    const params: (string | number)[] = [];
    if (at) params.push(at);
    const namespace = this.namespaceFilter(scope);
    where.push(namespace.where);
    params.push(...namespace.params);
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

  /** Namespace-only filtering also applies to explicitly requested historical snapshots. */
  namespaceFilter(scope: SearchScope, alias: "m" | "h" = "m"): SqlFilter {
    const { global, projects, bots } = this.reach(scope);
    const parts: string[] = [];
    const params: (string | number)[] = [];
    if (global) parts.push(`${alias}.scope = 'global'`);
    const project = partitionFilter(projects, `${alias}.project_key`);
    const bot = partitionFilter(bots, `${alias}.bot_id`);
    if (project) {
      parts.push(`(${alias}.scope = 'project' AND ${project.where})`);
      params.push(...project.params);
    }
    if (bot) {
      parts.push(`(${alias}.scope = 'bot' AND ${bot.where})`);
      params.push(...bot.params);
    }
    return { where: parts.length ? `(${parts.join(" OR ")})` : "0", params };
  }

  /** Session digests are project-scoped; bot grants do not imply their producing project. */
  sessionFilter(scope: SearchScope): SqlFilter | null {
    const project = partitionFilter(this.reach(scope).projects, "s.project_key");
    if (!project) return null;
    const current = `NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE
      (t.kind='session' AND t.identifier=s.agent_id)
      OR (t.kind='caller' AND t.identifier IN (SELECT nonce FROM agent_links WHERE agent_id=s.agent_id)))`;
    return { where: `${project.where} AND ${current}`, params: project.params };
  }
}

function grantKeys(grants: NamespaceGrants): ReadonlyMap<Operation, ReadonlySet<string>> {
  const result = new Map<Operation, ReadonlySet<string>>();
  const operations: Operation[] = ["read", "write", "delete", "restore", "merge"];
  for (const operation of operations)
    result.set(operation, new Set((grants[operation] ?? []).map(namespaceKey)));
  return result;
}

function namespaceReach(namespaces: readonly MemoryNamespace[]): Reach {
  let global = false;
  const projects = new Set<string>();
  const bots = new Set<string>();
  for (const namespace of namespaces) {
    if (namespace.kind === "global") global = true;
    else if (namespace.kind === "project") projects.add(namespace.projectKey);
    else bots.add(namespace.botId);
  }
  return { global, projects: explicitReach(projects), bots: explicitReach(bots) };
}

function explicitReach(keys: ReadonlySet<string>): NamespaceReach {
  return keys.size ? { kind: "some", keys: Object.freeze([...keys].sort()) } : { kind: "none" };
}

function partitionFilter(reach: NamespaceReach, column: string): SqlFilter | null {
  if (reach.kind === "none") return null;
  if (reach.kind === "every") return { where: "1", params: [] };
  return { where: `${column} IN (${reach.keys.map(() => "?").join(",")})`, params: [...reach.keys] };
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

function standaloneReach(kind: "owner" | "agent", projectKey: string | null): Reach {
  const unfocusedOwner = kind === "owner" && projectKey === null;
  return {
    global: true,
    projects: projectKey
      ? { kind: "some", keys: [projectKey] }
      : kind === "owner"
        ? { kind: "every" }
        : { kind: "none" },
    bots: unfocusedOwner ? { kind: "every" } : { kind: "none" },
  };
}
