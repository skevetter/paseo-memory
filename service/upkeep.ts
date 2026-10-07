import type { UpkeepList } from "../shared/service-api";
import type { MemoryStore, MemoryWithProject, ProjectRef } from "./store";
import { clip } from "./text";

const LAST_RUN_KEY = "upkeep_last_run";
export const UPKEEP_NONCE = "upkeep";
// Numbers with optional units, versions, `code spans` and "quoted values".
const VALUE = /`[^`]+`|"[^"]+"|\b\d+(?:[.:]\d+)*(?:%|ms|s|m|h|d|kb|mb|gb)?\b/gi;

export interface MemoryPair {
  a: MemoryWithProject;
  b: MemoryWithProject;
  similarity: number | null;
  sameTopic: boolean;
}

export function candidatePairs(store: MemoryStore): MemoryPair[] {
  const rows = store.liveRows();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pairs = new Map<string, MemoryPair>();
  const add = (a: MemoryWithProject, b: MemoryWithProject, similarity: number | null) => {
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const key = `${low.id}:${high.id}`;
    const sameTopic = low.topic_key !== null && low.topic_key === high.topic_key;
    const existing = pairs.get(key);
    pairs.set(key, { a: low, b: high, similarity: similarity ?? existing?.similarity ?? null, sameTopic });
  };
  for (const row of rows) {
    for (const near of store.nearDuplicatesOf(row)) {
      const other = byId.get(near.id);
      if (other && other.type === row.type) add(row, other, Math.round(near.similarity * 1000) / 1000);
    }
  }
  for (const [a, b] of sameTopicPairs(rows)) add(a, b, null);
  const dismissed = store.dismissedPairs();
  return [...pairs.entries()].filter(([key]) => !dismissed.has(key)).map(([, pair]) => pair);
}

function sameTopicPairs(rows: MemoryWithProject[]): [MemoryWithProject, MemoryWithProject][] {
  const byTopic = Map.groupBy(
    rows.filter((row) => row.topic_key !== null),
    (row) => row.topic_key,
  );
  return [...byTopic.values()].flatMap((group) =>
    group.flatMap((a, i) =>
      group
        .slice(i + 1)
        .filter((b) => a.project_key === b.project_key || a.scope === "global" || b.scope === "global")
        .map((b): [MemoryWithProject, MemoryWithProject] => [a, b]),
    ),
  );
}

export function valueTokens(text: string): string[] {
  return [...new Set((text.match(VALUE) ?? []).map((value) => value.toLowerCase()))];
}

// A pair contradicts when each side states a value the other does not, such as "port 6797" and "port 6798".
export function differingValues(pair: MemoryPair): { a: string[]; b: string[] } | null {
  const a = valueTokens(`${pair.a.title}\n${pair.a.content}`);
  const b = valueTokens(`${pair.b.title}\n${pair.b.content}`);
  const onlyA = a.filter((value) => !b.includes(value));
  const onlyB = b.filter((value) => !a.includes(value));
  return onlyA.length > 0 && onlyB.length > 0 ? { a: onlyA, b: onlyB } : null;
}

export function mergeTarget(pair: MemoryPair): MemoryWithProject {
  const { a, b } = pair;
  if (a.use_count !== b.use_count) return a.use_count > b.use_count ? a : b;
  return a.updated_at > b.updated_at ? a : b;
}

const pairMemory = (row: MemoryWithProject) => ({
  id: row.id,
  title: row.title,
  type: row.type,
  scope: row.scope,
  preview: clip(row.content, 240),
  updatedAt: row.updated_at,
  useCount: row.use_count,
});

const inProject = (row: MemoryWithProject, project: ProjectRef | null) =>
  row.scope === "global" || (project !== null && row.project_key === project.key);

export function upkeepPairs(
  store: MemoryStore,
  project: ProjectRef | null,
): Pick<UpkeepList, "duplicates" | "contradictions"> {
  const result: Pick<UpkeepList, "duplicates" | "contradictions"> = { duplicates: [], contradictions: [] };
  if (store.config.duplicateMerge === "off") return result;
  for (const pair of candidatePairs(store)) {
    if (!inProject(pair.a, project) || !inProject(pair.b, project)) continue;
    const view = {
      a: pairMemory(pair.a),
      b: pairMemory(pair.b),
      similarity: pair.similarity,
      sameTopic: pair.sameTopic,
    };
    const values = differingValues(pair);
    if (values) result.contradictions.push({ ...view, values });
    else result.duplicates.push({ ...view, targetId: mergeTarget(pair).id });
  }
  return result;
}

export function lastUpkeepRun(store: MemoryStore): string | null {
  return store.getMeta(LAST_RUN_KEY);
}

export interface UpkeepRun {
  merged: number;
  duplicates: number;
  contradictions: number;
  stale: number;
}

export function runUpkeep(store: MemoryStore, at: string): UpkeepRun {
  const run: UpkeepRun = { merged: 0, duplicates: 0, contradictions: 0, stale: 0 };
  run.stale = store.list({ project: null, scope: "all", stale: true, limit: 1000 }).length;
  store.setMeta(LAST_RUN_KEY, at);
  if (store.config.duplicateMerge === "off") return run;
  const gone = new Set<number>();
  for (const pair of candidatePairs(store)) {
    if (differingValues(pair)) {
      run.contradictions++;
      continue;
    }
    run.duplicates++;
    if (store.config.duplicateMerge === "auto" && autoMerge(store, pair, gone)) run.merged++;
  }
  return run;
}

function autoMerge(store: MemoryStore, pair: MemoryPair, gone: Set<number>): boolean {
  if (gone.has(pair.a.id) || gone.has(pair.b.id)) return false;
  const target = mergeTarget(pair);
  const source = target.id === pair.a.id ? pair.b : pair.a;
  if (!store.merge(source.id, target.id).ok) return false;
  gone.add(source.id);
  store.audit.record(UPKEEP_NONCE, {
    kind: "merge",
    source: source.id,
    target: target.id,
    similarity: pair.similarity,
    sameTopic: pair.sameTopic,
  });
  return true;
}
