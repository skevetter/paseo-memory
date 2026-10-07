import type { Strictness, TaskSource } from "../shared/service-api";
import { RERANK_TASK_FLOOR } from "./reranker";
import type { MemoryHit, MemoryStore, ProjectRef } from "./store";
import { clipWords } from "./text";

const MAX_QUERY_CHARS = 500;

export interface TaskInput {
  query: string;
  source: TaskSource;
}

export interface TaskMatches {
  query: string;
  source: TaskSource;
  hits: MemoryHit[];
  note: string | null;
}

interface TaskSearch {
  store: MemoryStore;
  project: ProjectRef | null;
  task: TaskInput;
  budgetMs: number;
}

export async function findTaskMatches(input: TaskSearch): Promise<TaskMatches> {
  const { store, task } = input;
  const query = clipWords(task.query, MAX_QUERY_CHARS);
  const result: TaskMatches = { query, source: task.source, hits: [], note: null };
  const { taskMatches: limit, taskStrictness: strictness } = store.config;
  if (limit === 0) return { ...result, note: "Task matches are turned off." };
  const timedOut = Promise.withResolvers<null>();
  const timer = setTimeout(() => timedOut.resolve(null), input.budgetMs);
  try {
    const search = store.search({ query, project: input.project, scope: "all", limit: limit * 3 });
    const hits = await Promise.race([search, timedOut.promise]);
    if (hits === null) {
      return {
        ...result,
        note: `The search took longer than ${input.budgetMs} ms, so only the general lists were used.`,
      };
    }
    const floor = taskFloor(store, strictness);
    const relevant = hits.filter((h): h is MemoryHit => h.kind === "memory" && isTaskMatch(h, floor));
    const note = relevant.length === 0 ? "No memory was close enough to this task." : null;
    return { ...result, hits: relevant.slice(0, limit), note };
  } finally {
    clearTimeout(timer);
  }
}

export interface TaskFloor {
  rerank: number;
  vector: number | null;
  keywordOnly: boolean;
}

export function taskFloor(store: MemoryStore, strictness: Strictness): TaskFloor {
  const spec = store.activeSpec;
  return {
    rerank: RERANK_TASK_FLOOR[strictness],
    vector: spec ? spec.taskFloor[strictness] : null,
    keywordOnly: strictness === "low",
  };
}

// Every available signal must clear its floor; without a model only low strictness accepts keyword hits.
export function isTaskMatch(hit: MemoryHit, floor: TaskFloor): boolean {
  if (hit.relevance !== null && hit.relevance < floor.rerank) return false;
  if (floor.vector === null) return hit.relevance !== null || floor.keywordOnly;
  return hit.similarity !== null && hit.similarity >= floor.vector;
}
