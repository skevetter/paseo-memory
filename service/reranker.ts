import type { EmbeddingTier, RerankMode, Strictness } from "../shared/service-api";
import type { ModelIdentity } from "./model-manifest";
import {
  createModelIdentity,
  ensureModelArtifacts,
  loadLocalTransformers,
  MODEL_MANIFESTS,
} from "./model-manifest";

export const RERANK_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";
export const RERANK_CANDIDATES = 30;
// Re-ranker probabilities a task match must reach; calibrated in tests/embedder.test.ts.
export const RERANK_TASK_FLOOR: Record<Strictness, number> = { low: 0.2, medium: 0.4, high: 0.65 };
const MAX_PAIR_TOKENS = 512;
const MAX_DOC_CHARS = 1500;

export interface Reranker {
  readonly model: string;
  readonly identity: Readonly<ModelIdentity>;
  score(query: string, docs: string[]): Promise<number[]>;
}

export function rerankEnabled(mode: RerankMode, tier: EmbeddingTier): boolean {
  if (mode !== "auto") return mode === "on";
  return tier === "medium" || tier === "high";
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export async function loadReranker(modelsDir: string): Promise<Reranker> {
  const manifest = MODEL_MANIFESTS.reranker;
  const identity = createModelIdentity(manifest, {
    task: "reranking",
    implementation: "transformers-sequence-classification-v1",
    dtype: "q8",
    dims: 1,
    pooling: "none",
    normalization: "none",
    queryPrefix: "",
    documentPrefix: "",
    maxInputChars: null,
    maxDocumentChars: MAX_DOC_CHARS,
    maxPairTokens: MAX_PAIR_TOKENS,
    padding: true,
    truncation: true,
    scoreTransform: "sigmoid",
  });
  const dir = await ensureModelArtifacts({ modelsDir, manifest });
  const transformers = await loadLocalTransformers();
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(dir, {
    local_files_only: true,
    revision: identity.tokenizerRevision,
  });
  const model = await transformers.AutoModelForSequenceClassification.from_pretrained(dir, {
    dtype: "q8",
    device: "cpu",
    local_files_only: true,
    revision: identity.modelRevision,
    use_external_data_format: false,
  });
  return {
    model: RERANK_MODEL,
    identity,
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
