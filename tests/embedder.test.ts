import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Embedder, loadEmbedder, TIERS, WordPieceTokenizer } from "../service/embedder";
import { loadReranker, RERANK_MODEL, RERANK_TASK_FLOOR } from "../service/reranker";
import { MemoryStore } from "../service/store";
import { EMBEDDING_TIERS, type EmbeddingTier } from "../shared/service-api";
import { BENCHMARK, CALIBRATION } from "./fixtures/calibration";
import { dataRepo } from "./helpers";

const modelsDir = process.env.PASEO_MEMORY_TEST_MODELS ?? join(tmpdir(), "paseo-memory-test-models");

function available(tier: EmbeddingTier): boolean {
  const spec = TIERS[tier];
  if (spec.backend === "model2vec") return process.env.PASEO_MEMORY_SKIP_MODEL !== "1";
  return (
    process.env.PASEO_MEMORY_DOWNLOAD_MODELS === "1" ||
    existsSync(join(modelsDir, spec.model, "onnx", "model_quantized.onnx"))
  );
}

const loaded = new Map<EmbeddingTier, Promise<Embedder>>();
function embedderFor(tier: EmbeddingTier): Promise<Embedder> {
  const existing = loaded.get(tier);
  if (existing) return existing;
  const next = loadEmbedder(tier, modelsDir);
  loaded.set(tier, next);
  return next;
}

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

async function taskScores(score: (query: string, docs: string[]) => Promise<number[]>) {
  const docs = BENCHMARK.corpus.map((c) => c.text);
  const rows: { relevant: number; typical: number }[] = [];
  for (const q of BENCHMARK.queries) {
    const scores = await score(q.query, docs);
    const index = BENCHMARK.corpus.findIndex((c) => c.key === q.relevant);
    const others = scores.filter((_, i) => i !== index).sort((a, b) => a - b);
    rows.push({ relevant: scores[index] ?? 0, typical: others[Math.floor(others.length / 2)] ?? 0 });
  }
  return rows;
}

function expectTaskFloor(
  rows: { relevant: number; typical: number }[],
  floor: { low: number; medium: number },
) {
  const share = (pass: (row: { relevant: number; typical: number }) => boolean) =>
    rows.filter(pass).length / rows.length;
  expect(share((r) => r.relevant >= floor.low)).toBeGreaterThanOrEqual(0.9);
  expect(share((r) => r.relevant >= floor.medium)).toBeGreaterThanOrEqual(0.8);
  expect(share((r) => r.typical < floor.medium)).toBeGreaterThanOrEqual(0.9);
}

async function similarity(embedder: Embedder, a: string, b: string): Promise<number> {
  const [x, y] = await embedder.embed([a, b], "document");
  return x && y ? dot(x, y) : Number.NaN;
}

async function retrieval(embedder: Embedder, query: string, docs: string[]): Promise<number[]> {
  const [q] = await embedder.embed([query], "query");
  const vectors = await embedder.embed(docs, "document");
  return vectors.map((v) => (q ? dot(q, v) : Number.NaN));
}

for (const tier of EMBEDDING_TIERS) {
  const spec = TIERS[tier];
  describe.skipIf(!available(tier))(`${tier} tier (${spec.model})`, () => {
    it(`produces normalized ${spec.dims}d vectors`, async () => {
      const embedder = await embedderFor(tier);
      const [v] = await embedder.embed(["which vector database did we pick?"], "query");
      expect(v?.length).toBe(spec.dims);
      expect(v ? dot(v, v) : 0).toBeCloseTo(1, 3);
    }, 300_000);

    it("tier calibration: restatements reach the duplicate threshold, distinct facts do not", async () => {
      const embedder = await embedderFor(tier);
      for (const [a, b] of CALIBRATION.duplicates) {
        expect(await similarity(embedder, a, b)).toBeGreaterThanOrEqual(spec.duplicateThreshold);
      }
      for (const [a, b] of CALIBRATION.distinct) {
        expect(await similarity(embedder, a, b)).toBeLessThan(spec.duplicateThreshold);
      }
    }, 300_000);

    it("tier calibration: relevant memories clear the search floor and outrank unrelated ones", async () => {
      const embedder = await embedderFor(tier);
      let ranked = 0;
      let excluded = 0;
      for (const [query, relevant, unrelated] of CALIBRATION.retrieval) {
        const [rel = 0, irr = 0] = await retrieval(embedder, query, [relevant, unrelated]);
        const floor = Math.max(spec.searchFloor.min, Math.max(rel, irr) * spec.searchFloor.relative);
        expect(rel).toBeGreaterThanOrEqual(floor);
        if (rel > irr) ranked++;
        if (irr < floor) excluded++;
      }
      // Static embeddings miss one paraphrase that every transformer tier gets right.
      expect(ranked).toBeGreaterThanOrEqual(spec.backend === "model2vec" ? 3 : CALIBRATION.retrieval.length);
      expect(excluded).toBeGreaterThanOrEqual(CALIBRATION.retrieval.length / 2);
    }, 300_000);

    it("tier calibration: task floors keep most relevant memories and drop typical unrelated ones", async () => {
      const embedder = await embedderFor(tier);
      const docs = await embedder.embed(
        BENCHMARK.corpus.map((c) => c.text),
        "document",
      );
      const rows = await taskScores(async (query) => {
        const [q] = await embedder.embed([query], "query");
        return docs.map((d) => (q ? dot(q, d) : Number.NaN));
      });
      expectTaskFloor(rows, spec.taskFloor);
    }, 300_000);

    it("finds semantic matches with no keyword overlap and returns near duplicates in the store", async () => {
      const store = new MemoryStore({ path: ":memory:" });
      try {
        store.setEmbedder(await embedderFor(tier));
        const base = { type: "decision", scope: "project" as const, project: dataRepo };
        await store.save({
          ...base,
          title: "Picked Postgres for the warehouse",
          content: "Why: joins and JSONB",
        });
        await store.save({ ...base, title: "Frontend uses React Native", content: "Why: mobile" });
        const hits = await store.search({ query: "which database engine was selected", project: dataRepo });
        expect(hits[0]?.title).toBe("Picked Postgres for the warehouse");
        const restated = {
          ...base,
          title: "Picked Postgres for the warehouse",
          content: "Why: joins and JSONB support",
        };
        expect(await store.save(restated)).toMatchObject({
          status: "near_duplicate",
          id: expect.any(Number),
        });
        expect((await store.save({ ...restated, force: true })).status).toBe("created");
      } finally {
        store.close();
      }
    }, 300_000);
  });
}

describe.skipIf(!available("zero"))("model2vec tokenizer", () => {
  it("matches the reference WordPiece output", async () => {
    await embedderFor("zero");
    const dir = join(modelsDir, "minishlab__potion-base-8M");
    const tokenizer = new WordPieceTokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")));
    expect(tokenizer.encode("Hello, world!")).toHaveLength(4);
    expect(tokenizer.encode("unaffable").length).toBeGreaterThan(1);
  }, 300_000);
});

const rerankerAvailable =
  process.env.PASEO_MEMORY_DOWNLOAD_MODELS === "1" ||
  existsSync(join(modelsDir, RERANK_MODEL, "onnx", "model_quantized.onnx"));

describe.skipIf(!rerankerAvailable)(`re-ranker (${RERANK_MODEL})`, () => {
  it("scores the relevant memory above the unrelated one for every calibration query", async () => {
    const reranker = await loadReranker(modelsDir);
    for (const [query, relevant, unrelated] of CALIBRATION.retrieval) {
      const [rel = 0, irr = 0] = await reranker.score(query, [relevant, unrelated]);
      expect(rel).toBeGreaterThan(irr);
      expect(rel).toBeLessThanOrEqual(1);
      expect(irr).toBeGreaterThanOrEqual(0);
    }
  }, 300_000);

  it("task floors keep most relevant memories and drop typical unrelated ones", async () => {
    const reranker = await loadReranker(modelsDir);
    expectTaskFloor(await taskScores((query, docs) => reranker.score(query, docs)), RERANK_TASK_FLOOR);
  }, 300_000);
});
