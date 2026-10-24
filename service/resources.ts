import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { InferenceQueueSnapshot, InferenceStageSnapshot } from "../shared/inference";
import type { ModelIndexStatus, ResourceStatus, ResourceUsage } from "../shared/resources";
import { currentLifecycleSql } from "./lifecycle";
import { INDEX_RETENTION, indexTarget, type ModelIndexRow, modelIndexes } from "./model-indexes";

interface SnapshotInput {
  at: string;
  servingFingerprint: string | null;
  rerankerFingerprint: string | null;
  inference: InferenceQueueSnapshot;
  retrieval: InferenceStageSnapshot;
  usage: ResourceUsage;
  currentFeedbackHints?: Pick<
    ResourceStatus["feedback"],
    "applications" | "validatedHelpful" | "validatedHarmful"
  >;
}
const DescriptorSchema = z.object({
  identity: z.object({
    schemaVersion: z.literal(1),
    artifacts: z
      .array(z.object({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }))
      .min(1)
      .max(16),
  }),
});

export function resourceSnapshot(db: Database, input: SnapshotInput): ResourceStatus {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const indexes = modelIndexes(db);
  const sizes = indexPageSizes(db, indexes);
  return {
    observationEpoch: meta(db, "resource_observation_epoch"),
    observedAt: input.at,
    rerankerFingerprint: input.rerankerFingerprint,
    process: {
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      uptimeMs: process.uptime() * 1000,
      basis: "process_cumulative_not_per_request",
    },
    inference: input.inference,
    retrieval: input.retrieval,
    indexes: {
      servingFingerprint: input.servingFingerprint,
      readyFingerprint: meta(db, "embedding_ready_fingerprint"),
      targetFingerprint: indexTarget(db),
      corpusRecords: scalar(db, "SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL"),
      eligibleRecords:
        db
          .query<{ n: number }, [string]>(
            `SELECT count(*) AS n FROM memories m WHERE m.deleted_at IS NULL AND ${currentLifecycleSql("m", "?")}`,
          )
          .get(input.at)?.n ?? 0,
      currentEntries: currentEntries(db, input.servingFingerprint, input.at),
      databaseBytes: databaseBytes(db),
      retention: { ...INDEX_RETENTION },
      items: indexes.map((index) => indexStatus(db, index, sizes)),
    },
    usage: input.usage,
    feedback: feedbackStatus(db, input.currentFeedbackHints),
  };
}
function meta(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
}
function scalar(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}
function databaseBytes(db: Database): number {
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const size = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  return pages * size;
}
function currentEntries(db: Database, fingerprint: string | null, at: string): number {
  if (!fingerprint) return 0;
  return (
    db
      .query<
        { n: number },
        [string, string]
      >(`SELECT count(*) AS n FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
  WHERE e.index_fingerprint=? AND e.content_hash=m.content_hash AND e.index_generation=m.index_generation
  AND m.deleted_at IS NULL AND ${currentLifecycleSql("m", "?")}`)
      .get(fingerprint, at)?.n ?? 0
  );
}
function indexStatus(
  db: Database,
  index: ModelIndexRow,
  sizes: Map<string, number> | null,
): ModelIndexStatus {
  const artifactBytes = manifestBytes(index.identity_json);
  return {
    fingerprint: index.fingerprint,
    generation: index.generation,
    model: index.model,
    dims: index.dims,
    state: index.state,
    entries:
      db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM memory_embeddings WHERE index_fingerprint=?",
        )
        .get(index.fingerprint)?.n ?? 0,
    identityKnown: artifactBytes !== null,
    createdAt: index.created_at,
    readyAt: index.ready_at,
    retiredAt: index.retired_at,
    indexBytes: index.table_name ? (sizes?.get(index.table_name) ?? null) : null,
    artifactBytes,
  };
}
function manifestBytes(json: string | null): number | null {
  if (!json) return null;
  try {
    const parsed = DescriptorSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const bytes = parsed.data.identity.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
// dbstat is optional. These are allocated SQLite pages, not WAL/filesystem/native allocator overhead.
function indexPageSizes(db: Database, indexes: ModelIndexRow[]): Map<string, number> | null {
  if (!db.query("SELECT 1 FROM pragma_module_list WHERE name='dbstat'").get()) return null;
  const pages = db
    .query<{ name: string; pgsize: number }, []>("SELECT name,pgsize FROM dbstat WHERE aggregate=TRUE")
    .all();
  const tables = indexes
    .flatMap((index) => (index.table_name ? [index.table_name] : []))
    .sort((a, b) => b.length - a.length);
  const sizes = new Map<string, number>();
  for (const page of pages) {
    const owner = tables.find((table) => page.name === table || page.name.startsWith(`${table}_`));
    if (owner) sizes.set(owner, (sizes.get(owner) ?? 0) + page.pgsize);
  }
  return sizes;
}
function feedbackStatus(
  db: Database,
  currentHints: SnapshotInput["currentFeedbackHints"],
): ResourceStatus["feedback"] {
  const activity = db
    .query<
      {
        exposures: number;
        opens: number;
        applications: number;
        validatedHelpful: number;
        validatedHarmful: number;
      },
      []
    >(`SELECT
  coalesce(sum(shown_count),0) AS exposures,coalesce(sum(opened_count),0) AS opens,coalesce(sum(application_count),0) AS applications,
  coalesce(sum(validated_helpful_count),0) AS validatedHelpful,coalesce(sum(validated_harmful_count),0) AS validatedHarmful FROM memories`)
    .get();
  const feedback = {
    exposures: 0,
    opens: 0,
    applications: 0,
    validatedHelpful: 0,
    validatedHarmful: 0,
    ...activity,
    ...currentHints,
    agentReported: 0,
    humanReported: 0,
    validatorReported: 0,
    basis:
      "Exposures/opens are cumulative; application and validated counters belong to current revisions, not causal improvement or verified factual freshness." as const,
  };
  for (const row of db
    .query<{ basis: string; n: number }, []>("SELECT basis,count(*) AS n FROM memory_feedback GROUP BY basis")
    .all()) {
    if (row.basis === "agent_report") feedback.agentReported = row.n;
    if (row.basis === "human") feedback.humanReported = row.n;
    if (row.basis === "validator") feedback.validatorReported = row.n;
  }
  return feedback;
}
