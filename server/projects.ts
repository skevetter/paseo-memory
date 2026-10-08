import { resolve, sep } from "node:path";
import type { ProjectRef } from "../shared/service-api";
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

export interface ProjectResolver {
  resolve(paseo: PaseoApi, input: ProjectLookup): Promise<ProjectRef | null>;
  forget(cacheKey: string): void;
}

async function lookupProject(paseo: PaseoApi, input: ProjectLookup): Promise<ProjectRef | null> {
  const [{ entries }, { projects }] = await Promise.all([
    paseo.workspaces.list({ page: { limit: 200 } }),
    paseo.projects.list(),
  ]);
  const byId = input.workspaceId ? entries.find((w) => w.id === input.workspaceId) : undefined;
  return projectForWorkspace(byId ?? workspaceForCwd(entries, input.cwd), projects);
}

export function createProjectResolver(
  onResolved: (project: ProjectRef) => void,
  log: (m: string) => void,
): ProjectResolver {
  const cache = new Map<string, { project: ProjectRef | null; at: number }>();
  return {
    async resolve(paseo, input) {
      const cacheKey = input.workspaceId ?? input.cwd;
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.project;
      const project = await lookupProject(paseo, input).catch((error: unknown) => {
        log(`project lookup failed: ${String(error)}`);
        return null;
      });
      cache.set(cacheKey, { project, at: Date.now() });
      if (project) onResolved(project);
      return project;
    },
    forget: (cacheKey) => void cache.delete(cacheKey),
  };
}
