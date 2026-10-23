import { resolve, sep } from "node:path";
import type { ProjectRef, ProjectUnresolved } from "../shared/service-api";
import type { PaseoApi } from "./host-types";

interface ProjectDescriptor {
  projectId: string;
  projectKey?: string;
  projectDisplayName: string;
  projectRootPath: string;
}

interface WorkspaceEntry {
  id: string;
  projectId?: string | null;
  workspaceDirectory?: string | null;
  projectRootPath?: string | null;
  projectDisplayName?: string | null;
}

const CACHE_MS = 5 * 60_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const LOOKUP_DEADLINE_MS = 5000;

export function projectFromDescriptor(d: ProjectDescriptor): ProjectRef {
  return {
    key: d.projectKey || `path:${d.projectRootPath}`,
    name: d.projectDisplayName,
    rootPath: d.projectRootPath,
    paseoProjectId: d.projectId,
  };
}

export function workspaceForCwd<W extends WorkspaceEntry>(entries: readonly W[], cwd: string): W | undefined {
  const target = resolve(cwd);
  return entries
    .filter((w) => {
      const dir = w.workspaceDirectory ? resolve(w.workspaceDirectory) : null;
      return dir !== null && (target === dir || target.startsWith(dir + sep));
    })
    .sort((a, b) => (b.workspaceDirectory?.length ?? 0) - (a.workspaceDirectory?.length ?? 0))[0];
}

export function projectForWorkspace(
  workspace: WorkspaceEntry | undefined,
  descriptors: readonly ProjectDescriptor[],
): ProjectRef | null {
  const projectId = workspace?.projectId;
  if (!workspace || !projectId) return null;
  const descriptor = descriptors.find((p) => p.projectId === projectId);
  if (descriptor) return projectFromDescriptor(descriptor);
  const rootPath = workspace.projectRootPath ?? null;
  return {
    key: rootPath ? `path:${rootPath}` : `paseo:${projectId}`,
    name: workspace.projectDisplayName ?? projectId,
    rootPath,
    paseoProjectId: projectId,
  };
}

export interface ProjectLookup {
  cwd: string;
  workspaceId?: string | null;
}

export interface ProjectResolution {
  project: ProjectRef | null;
  unresolved: ProjectUnresolved | null;
}

export interface ProjectResolver {
  resolve(paseo: PaseoApi, input: ProjectLookup): Promise<ProjectResolution>;
  forget(cacheKey: string): void;
}

interface ResolverOptions {
  deadlineMs?: number;
}

class LookupFailure extends Error {
  readonly reason: ProjectUnresolved;

  constructor(reason: ProjectUnresolved) {
    super(reason);
    this.reason = reason;
  }
}

interface WorkspacePage {
  entries: WorkspaceEntry[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

const pageRequest = (cursor: string | null) => ({
  page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
});

// Workspaces arrive in pages; the daemon has no lookup by id, so walk the cursor until the target shows up.
async function collectWorkspaces(
  paseo: PaseoApi,
  input: ProjectLookup,
  expiresAt: number,
): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() >= expiresAt) throw new LookupFailure("deadline");
    const result: WorkspacePage = await paseo.workspaces.list(pageRequest(cursor));
    entries.push(...result.entries);
    const found = input.workspaceId && result.entries.some((w) => w.id === input.workspaceId);
    const next: string | null = result.pageInfo.hasMore ? result.pageInfo.nextCursor : null;
    if (found || !next) return entries;
    cursor = next;
  }
  throw new LookupFailure("page_limit");
}

async function lookupProject(
  paseo: PaseoApi,
  input: ProjectLookup,
  deadlineMs: number,
): Promise<ProjectResolution> {
  const expiresAt = Date.now() + deadlineMs;
  const timer = Promise.withResolvers<never>();
  const timeout = setTimeout(() => timer.reject(new LookupFailure("deadline")), deadlineMs);
  try {
    const [entries, { projects }] = await Promise.race([
      Promise.all([collectWorkspaces(paseo, input, expiresAt), paseo.projects.list()]),
      timer.promise,
    ]);
    const byId = input.workspaceId ? entries.find((w) => w.id === input.workspaceId) : undefined;
    const project = projectForWorkspace(byId ?? workspaceForCwd(entries, input.cwd), projects);
    return { project, unresolved: project ? null : "no_project" };
  } finally {
    clearTimeout(timeout);
  }
}

export function createProjectResolver(
  onResolved: (project: ProjectRef) => void,
  log: (m: string) => void,
  options: ResolverOptions = {},
): ProjectResolver {
  const cache = new Map<string, { resolution: ProjectResolution; at: number }>();
  const deadlineMs = options.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const lookup = async (paseo: PaseoApi, input: ProjectLookup, cacheKey: string) => {
    try {
      const resolution = await lookupProject(paseo, input, deadlineMs);
      cache.set(cacheKey, { resolution, at: Date.now() });
      if (resolution.project) onResolved(resolution.project);
      return resolution;
    } catch (error) {
      // Failures are not cached: the next call should retry instead of staying project-less for minutes.
      const unresolved = error instanceof LookupFailure ? error.reason : "lookup_failed";
      log(`project lookup failed (${unresolved}): ${String(error)}`);
      return { project: null, unresolved };
    }
  };
  return {
    async resolve(paseo, input) {
      const cacheKey = input.workspaceId ?? input.cwd;
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.resolution;
      return lookup(paseo, input, cacheKey);
    },
    forget: (cacheKey) => void cache.delete(cacheKey),
  };
}
