import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Embedder, loadEmbedder } from "../service/embedder";
import { loadReranker, type Reranker } from "../service/reranker";
import { MemoryStore } from "../service/store";
import { EMBEDDING_TIERS, type EmbeddingTier } from "../shared/service-api";
import { BENCHMARK, type BenchQuery } from "../tests/fixtures/calibration";
import { dataRepo } from "../tests/helpers";

const { values } = parseArgs({
  options: { "models-dir": { type: "string" }, tiers: { type: "string" } },
  strict: true,
});
const modelsDir =
  values["models-dir"] ?? process.env.PASEO_MEMORY_TEST_MODELS ?? join(tmpdir(), "paseo-memory-test-models");
const tiers = (values.tiers?.split(",") ?? [...EMBEDDING_TIERS]).filter((t): t is EmbeddingTier =>
  EMBEDDING_TIERS.some((known) => known === t),
);

interface Run {
  top1: number;
  mrr: number;
  msPerSearch: number;
  byKind: Record<BenchQuery["kind"], number>;
}

async function seededStore(embedder: Embedder): Promise<{ store: MemoryStore; keyOf: Map<string, string> }> {
  const store = new MemoryStore({ path: ":memory:" });
  store.setEmbedder(embedder);
  const keyOf = new Map<string, string>();
  for (const memory of BENCHMARK.corpus) {
    const [title = "", ...rest] = memory.text.split("\n");
    const saved = await store.save({
      title,
      content: rest.join("\n") || title,
      type: "note",
      scope: "project",
      project: dataRepo,
      force: true,
    });
    keyOf.set(String(saved.id), memory.key);
  }
  await store.indexPending();
  return { store, keyOf };
}

async function measure(store: MemoryStore, keyOf: Map<string, string>): Promise<Run> {
  let top1 = 0;
  let reciprocal = 0;
  let elapsed = 0;
  const byKind = { paraphrase: 0, "no-overlap": 0, "near-miss": 0 };
  for (const q of BENCHMARK.queries) {
    const started = performance.now();
    const hits = await store.search({ query: q.query, project: dataRepo, limit: 10 });
    elapsed += performance.now() - started;
    const rank = hits.findIndex((h) => keyOf.get(h.id) === q.relevant) + 1;
    if (rank === 1) {
      top1++;
      byKind[q.kind]++;
    }
    if (rank > 0) reciprocal += 1 / rank;
  }
  const n = BENCHMARK.queries.length;
  return { top1, mrr: reciprocal / n, msPerSearch: elapsed / n, byKind };
}

function row(label: string, run: Run, added: string): string {
  const n = BENCHMARK.queries.length;
  const kinds = `${run.byKind.paraphrase}/${run.byKind["no-overlap"]}/${run.byKind["near-miss"]}`;
  return `| ${label} | ${run.top1}/${n} | ${run.mrr.toFixed(3)} | ${kinds} | ${run.msPerSearch.toFixed(1)} | ${added} |`;
}

async function benchTier(tier: EmbeddingTier, reranker: Reranker): Promise<string[]> {
  const { store, keyOf } = await seededStore(await loadEmbedder(tier, modelsDir));
  // One warm-up pass so model initialization does not count as search latency.
  await measure(store, keyOf);
  const fused = await measure(store, keyOf);
  store.setReranker(reranker);
  await store.search({ query: "warm up", project: dataRepo });
  const reranked = await measure(store, keyOf);
  store.close();
  const added = (reranked.msPerSearch - fused.msPerSearch).toFixed(1);
  return [row(`${tier}`, fused, "-"), row(`${tier} + re-rank`, reranked, `+${added}`)];
}

const print = (text: string) => process.stdout.write(`${text}\n`);

const counts = BENCHMARK.queries.reduce<Record<string, number>>((acc, q) => {
  acc[q.kind] = (acc[q.kind] ?? 0) + 1;
  return acc;
}, {});
print(
  `${BENCHMARK.queries.length} queries (paraphrase ${counts.paraphrase}, no-overlap ${counts["no-overlap"]}, ` +
    `near-miss ${counts["near-miss"]}) over ${BENCHMARK.corpus.length} memories, top 10 per search\n`,
);
print("| Tier | Top-1 | MRR | Top-1 by kind (para/no-overlap/near-miss) | ms per search | Added ms |");
print("| --- | --- | --- | --- | --- | --- |");
const reranker = await loadReranker(modelsDir);
for (const tier of tiers) {
  for (const line of await benchTier(tier, reranker)) print(line);
}
