import type { Strictness, TaskSource } from "../shared/service-api";
import { RERANK_TASK_FLOOR } from "./reranker";
import type { MemoryHit, MemoryStore } from "./store";

export interface TaskInput {
  query: string;
  source: TaskSource;
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
export function isTaskMatch(hit: Pick<MemoryHit, "relevance" | "similarity">, floor: TaskFloor): boolean {
  if (hit.relevance !== null && hit.relevance < floor.rerank) return false;
  if (floor.vector === null) return hit.relevance !== null || floor.keywordOnly;
  return hit.similarity !== null && hit.similarity >= floor.vector;
}
