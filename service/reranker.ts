// Optional cross-encoder re-ranker. After keyword and vector fusion, the store rescores the top
// candidates with a model that reads the query and each memory together, then keeps the top k.
// gte-reranker-modernbert-base pairs with the medium embedder; it runs on transformers.js in
// the service like the embedding tiers and downloads into the same models directory.

import { mkdirSync } from "node:fs";
import type { EmbeddingTier, RerankMode } from "../shared/service-api";

export const RERANK_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";
// Candidates rescored per search, and the longest memory text the model reads.
export const RERANK_CANDIDATES = 30;
const MAX_PAIR_TOKENS = 512;
const MAX_DOC_CHARS = 1500;

export interface Reranker {
  readonly model: string;
  // Relevance in [0, 1] per document, in input order.
  score(query: string, docs: string[]): Promise<number[]>;
}

// auto turns re-ranking on for the transformer tiers that can afford its latency.
export function rerankEnabled(mode: RerankMode, tier: EmbeddingTier): boolean {
  if (mode !== "auto") return mode === "on";
  return tier === "medium" || tier === "high";
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export async function loadReranker(modelsDir: string): Promise<Reranker> {
  // Loaded on demand, like the embedder: transformers.js pulls in the onnxruntime-node native
  // addon, which the zero tier with re-ranking off must never load.
  const transformers = await import("@huggingface/transformers");
  mkdirSync(modelsDir, { recursive: true });
  transformers.env.cacheDir = modelsDir;
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(RERANK_MODEL);
  // q8 when the repository ships it, full precision otherwise.
  const model = await transformers.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
    dtype: "q8",
  }).catch(() => transformers.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL));
  return {
    model: RERANK_MODEL,
    async score(query, docs) {
      if (docs.length === 0) return [];
      const inputs = tokenizer(
        docs.map(() => query),
        {
          text_pair: docs.map((d) => d.slice(0, MAX_DOC_CHARS)),
          padding: true,
          truncation: true,
          max_length: MAX_PAIR_TOKENS,
        },
      );
      const { logits } = await model(inputs);
      const data: ArrayLike<number> = logits.data;
      if (data.length !== docs.length) throw new Error(`${RERANK_MODEL} returned ${data.length} scores`);
      return Array.from(data, sigmoid);
    },
  };
}
