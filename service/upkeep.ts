import type { UpkeepList } from "../shared/service-api";
import { Access } from "./access";
import type { MemoryStore, MemoryWithProject, ProjectRef } from "./store";
import { clip } from "./text";

const LAST_RUN_KEY = "upkeep_last_run";
export const UPKEEP_NONCE = "upkeep";
// Upkeep is host maintenance, not an agent request.
const OWNER = Access.owner();
// Numbers with optional units, versions, `code spans` and "quoted values".
const VALUE = /`[^`]+`|"[^"]+"|\b\d+(?:[.:]\d+)*(?:%|ms|s|m|h|d|kb|mb|gb)?\b/gi;
const NEGATION =
  /\b(?:not|never|no|none|cannot|can't|don't|doesn't|didn't|won't|shouldn't|isn't|aren't|without|avoid|stop|disable[ds]?|deprecated)\b/i;

export interface MemoryPair {
  a: MemoryWithProject;
  b: MemoryWithProject;
  similarity: number | null;
  sameTopic: boolean;
}

type Conflict = { reason: "values" | "negation"; values: { a: string[]; b: string[] } };

export function candidatePairs(store: MemoryStore): MemoryPair[] {
  const rows = store.liveRows(OWNER);
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

// A pair differs when each side states a value the other does not, such as "port 6797" and "port 6798".
export function differingValues(pair: MemoryPair): { a: string[]; b: string[] } | null {
  const a = valueTokens(`${pair.a.title}\n${pair.a.content}`);
  const b = valueTokens(`${pair.b.title}\n${pair.b.content}`);
  const onlyA = a.filter((value) => !b.includes(value));
  const onlyB = b.filter((value) => !a.includes(value));
  return onlyA.length > 0 && onlyB.length > 0 ? { a: onlyA, b: onlyB } : null;
}

const isNegated = (row: MemoryWithProject) => NEGATION.test(`${row.title}\n${row.content}`);

// Both checks are heuristics, so a hit only asks the owner to look; it never decides anything.
export function possibleConflict(pair: MemoryPair): Conflict | null {
  const values = differingValues(pair);
  if (values) return { reason: "values", values };
  if (isNegated(pair.a) !== isNegated(pair.b)) return { reason: "negation", values: { a: [], b: [] } };
  return null;
}

const canonical = (text: string) => text.normalize("NFC").trim();

const sameNamespace = (pair: MemoryPair) =>
  pair.a.scope === pair.b.scope && pair.a.project_key === pair.b.project_key;

/**
 * The only pairs automatic merging may touch: the same canonical text, type, namespace and authority. A similar
 * but different statement, or one across the global/project boundary, stays a suggestion for the owner.
 */
export function isExactDuplicate(pair: MemoryPair): boolean {
  const { a, b } = pair;
  return (
    sameNamespace(pair) &&
    a.type === b.type &&
    a.source === b.source &&
    a.agent_id === b.agent_id &&
    a.provider === b.provider &&
    a.pinned === b.pinned &&
    a.record_kind === b.record_kind &&
    a.verification_status === b.verification_status &&
    a.valid_from === b.valid_from &&
    a.valid_until === b.valid_until &&
    a.archived_at === null &&
    b.archived_at === null &&
    canonical(a.title) === canonical(b.title) &&
    canonical(a.content) === canonical(b.content) &&
    possibleConflict(pair) === null
  );
}

export function mergeTarget(pair: MemoryPair): MemoryWithProject {
  const { a, b } = pair;
  const activity = (row: MemoryWithProject) => row.application_count + row.validated_helpful_count;
  if (activity(a) !== activity(b)) return activity(a) > activity(b) ? a : b;
  if (a.opened_count !== b.opened_count) return a.opened_count > b.opened_count ? a : b;
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
  revision: row.record_revision,
});

const inProject = (row: MemoryWithProject, project: ProjectRef | null) =>
  row.scope === "global" || (project !== null && row.project_key === project.key);

export function upkeepPairs(
  store: MemoryStore,
  project: ProjectRef | null,
): Pick<UpkeepList, "duplicates" | "conflicts"> {
  const result: Pick<UpkeepList, "duplicates" | "conflicts"> = { duplicates: [], conflicts: [] };
  if (store.config.duplicateMerge === "off") return result;
  for (const pair of candidatePairs(store)) {
    if (!inProject(pair.a, project) || !inProject(pair.b, project)) continue;
    const view = {
      a: pairMemory(pair.a),
      b: pairMemory(pair.b),
      similarity: pair.similarity,
      sameTopic: pair.sameTopic,
    };
    const conflict = possibleConflict(pair);
    if (conflict) result.conflicts.push({ ...view, ...conflict });
    else if (sameNamespace(pair)) {
      result.duplicates.push({ ...view, targetId: mergeTarget(pair).id, exact: isExactDuplicate(pair) });
    }
  }
  return result;
}

export function lastUpkeepRun(store: MemoryStore): string | null {
  return store.getMeta(LAST_RUN_KEY);
}

export interface UpkeepRun {
  merged: number;
  duplicates: number;
  conflicts: number;
  stale: number;
}

export function runUpkeep(store: MemoryStore, at: string): UpkeepRun {
  const run: UpkeepRun = { merged: 0, duplicates: 0, conflicts: 0, stale: 0 };
  run.stale = store.list({ access: OWNER, scope: "all", stale: true, limit: 1000 }).length;
  store.setMeta(LAST_RUN_KEY, at);
  if (store.config.duplicateMerge === "off") return run;
  const gone = new Set<number>();
  for (const pair of candidatePairs(store)) {
    if (possibleConflict(pair)) {
      run.conflicts++;
      continue;
    }
    if (!sameNamespace(pair)) continue;
    run.duplicates++;
    if (store.config.duplicateMerge === "auto" && isExactDuplicate(pair) && autoMerge(store, pair, gone)) {
      run.merged++;
    }
  }
  return run;
}

function autoMerge(store: MemoryStore, pair: MemoryPair, gone: Set<number>): boolean {
  if (gone.has(pair.a.id) || gone.has(pair.b.id)) return false;
  const target = mergeTarget(pair);
  const source = target.id === pair.a.id ? pair.b : pair.a;
  const request = {
    sourceId: source.id,
    targetId: target.id,
    sourceRevision: source.record_revision,
    targetRevision: target.record_revision,
  };
  if (!store.mergeAuthorized(OWNER, request, "upkeep").ok) return false;
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
