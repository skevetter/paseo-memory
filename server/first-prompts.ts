import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const TTL_MS = 2 * 60_000;
const MAX_PENDING = 50;

export interface WorkspaceCreateInput {
  firstAgentContext?: { prompt?: string };
  source:
    | { kind: "directory"; path: string; projectId?: string }
    | { kind: "worktree"; cwd?: string; projectId?: string; worktreeSlug?: string };
}

export interface AgentPlacement {
  cwd: string;
  projectId: string | null;
  projectRoot: string | null;
}

interface Pending {
  prompt: string;
  kind: "directory" | "worktree";
  sourceDir: string | null;
  projectId: string | null;
  slug: string | null;
  at: number;
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

// macOS reaches temp and home folders through symlinks such as /var -> /private/var, so compare real paths.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Strongest evidence first: cwd inside a directory source, then the worktree slug, then the same project.
const MATCHERS: ((entry: Pending, agent: AgentPlacement) => boolean)[] = [
  (entry, agent) =>
    entry.kind === "directory" && entry.sourceDir !== null && inside(agent.cwd, entry.sourceDir),
  (entry, agent) => entry.slug !== null && agent.cwd.split(sep).includes(entry.slug),
  (entry, agent) =>
    (entry.projectId !== null && entry.projectId === agent.projectId) ||
    (entry.sourceDir !== null &&
      agent.projectRoot !== null &&
      entry.sourceDir === canonical(agent.projectRoot)),
];

// before("workspace.create") sees the first prompt; the agent.create that follows for that workspace takes it.
export class FirstPrompts {
  private pending: Pending[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  remember(request: WorkspaceCreateInput): boolean {
    const prompt = request.firstAgentContext?.prompt?.trim();
    if (!prompt) return false;
    const { source } = request;
    const dir = source.kind === "directory" ? source.path : source.cwd;
    this.pending.push({
      prompt,
      kind: source.kind,
      sourceDir: dir ? canonical(dir) : null,
      projectId: source.projectId ?? null,
      slug: source.kind === "worktree" ? (source.worktreeSlug ?? null) : null,
      at: this.now(),
    });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return true;
  }

  take(agent: AgentPlacement): string | null {
    const cutoff = this.now() - TTL_MS;
    this.pending = this.pending.filter((entry) => entry.at >= cutoff);
    const placement = { ...agent, cwd: canonical(agent.cwd) };
    for (const matches of MATCHERS) {
      const found = this.pending.find((entry) => matches(entry, placement));
      if (!found) continue;
      this.pending = this.pending.filter((entry) => entry !== found);
      return found.prompt;
    }
    return null;
  }
}
