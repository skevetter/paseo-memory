import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskSource } from "../shared/service-api";

const GENERIC_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "head"]);

export interface TaskNames {
  prompt: string | null;
  title: string | null;
  branch: string | null;
  folder: string | null;
}

export interface TaskQuery {
  query: string;
  source: TaskSource;
}

// The first message says what the agent will do; without one, the names around the agent are the best hint.
export function taskQuery(names: TaskNames): TaskQuery | null {
  const prompt = names.prompt?.trim();
  if (prompt) return { query: prompt, source: "prompt" };
  const branch = names.branch && !GENERIC_BRANCHES.has(names.branch.toLowerCase()) ? names.branch : null;
  const pathNames = [branch, names.folder].map((name) => name?.replace(/[-_/.]+/g, " "));
  const parts: string[] = [];
  for (const part of [names.title, ...pathNames].map((name) => name?.trim())) {
    if (part && !parts.some((seen) => seen.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  return parts.length > 0 ? { query: parts.join(" "), source: "names" } : null;
}

export function readBranch(cwd: string): string | null {
  try {
    const gitDir = findGitDir(resolve(cwd));
    if (!gitDir) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

// A worktree's .git is a file that points at its real git directory.
function findGitDir(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return gitDirAt(dir, candidate);
    if (dirname(dir) === dir) return null;
  }
}

function gitDirAt(dir: string, candidate: string): string | null {
  if (statSync(candidate).isDirectory()) return candidate;
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"))?.[1]?.trim();
  return pointer ? resolve(dir, pointer) : null;
}
