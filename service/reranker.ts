import { mkdirSync } from "node:fs";
import type { EmbeddingTier, RerankMode } from "../shared/service-api";

export const RERANK_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";
export const RERANK_CANDIDATES = 30;
const MAX_PAIR_TOKENS = 512;
const MAX_DOC_CHARS = 1500;

export interface Reranker {
  readonly model: string;
  score(query: string, docs: string[]): Promise<number[]>;
}

export function rerankEnabled(mode: RerankMode, tier: EmbeddingTier): boolean {
  if (mode !== "auto") return mode === "on";
  return tier === "medium" || tier === "high";
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export async function loadReranker(modelsDir: string): Promise<Reranker> {
  // Dynamic import, as in the embedder: re-ranking off must never load onnxruntime-node.
  const transformers = await import("@huggingface/transformers");
  mkdirSync(modelsDir, { recursive: true });
  transformers.env.cacheDir = modelsDir;
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(RERANK_MODEL);
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
