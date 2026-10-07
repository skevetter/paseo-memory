// Embedding tiers for the memory service. One table (TIERS) defines every model; the loader
// reads only that table, so adding a model means adding a row.
// zero runs model2vec in pure TypeScript (WordPiece tokenizer plus a mean of static token
// vectors, no ONNX runtime). The other tiers run transformers.js on onnxruntime-node in-process.
// Models download on first use into the service's models directory.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingTier } from "../shared/service-api";

export type EmbedKind = "document" | "query";

export interface TierSpec {
  tier: EmbeddingTier;
  model: string;
  backend: "model2vec" | "transformers";
  // transformers.js dtype and pooling; model2vec ignores both.
  dtype: "q8" | "fp32";
  pooling: "cls" | "mean";
  dims: number;
  queryPrefix: string;
  documentPrefix: string;
  // Cosine similarity at or above which a new memory is reported as possible_duplicate.
  duplicateThreshold: number;
  // Vector hits enter fusion only at or above max(min, best hit * relative).
  searchFloor: { min: number; relative: number };
}

const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// Thresholds are calibrated per model against tests/fixtures/calibration.ts by the
// "tier calibration" tests in tests/embedder.test.ts. Cosine similarities on that fixture:
//   tier    duplicates   distinct facts  relevant hit  unrelated
//   zero    0.976-1.000  0.195-0.645     0.189-0.390   0.013-0.245
//   low     0.987-0.994  0.632-0.754     0.635-0.691   0.486-0.626
//   medium  0.987-0.992  0.533-0.731     0.560-0.717   0.404-0.517
//   high    0.982-0.995  0.607-0.761     0.582-0.666   0.414-0.576
// Static embeddings score low and spread wide; transformer models score high and compress.
export const TIERS: Record<EmbeddingTier, TierSpec> = {
  zero: {
    tier: "zero",
    model: "minishlab/potion-base-8M",
    backend: "model2vec",
    dtype: "fp32",
    pooling: "mean",
    dims: 256,
    queryPrefix: "",
    documentPrefix: "",
    duplicateThreshold: 0.92,
    searchFloor: { min: 0.12, relative: 0.5 },
  },
  low: {
    tier: "low",
    model: "Xenova/bge-small-en-v1.5",
    backend: "transformers",
    dtype: "q8",
    pooling: "cls",
    dims: 384,
    queryPrefix: BGE_QUERY_PREFIX,
    documentPrefix: "",
    duplicateThreshold: 0.9,
    searchFloor: { min: 0.55, relative: 0.88 },
  },
  medium: {
    tier: "medium",
    model: "Alibaba-NLP/gte-modernbert-base",
    backend: "transformers",
    dtype: "q8",
    pooling: "cls",
    dims: 768,
    queryPrefix: "",
    documentPrefix: "",
    duplicateThreshold: 0.9,
    searchFloor: { min: 0.5, relative: 0.85 },
  },
  high: {
    tier: "high",
    model: "Xenova/bge-large-en-v1.5",
    backend: "transformers",
    dtype: "q8",
    pooling: "cls",
    dims: 1024,
    queryPrefix: BGE_QUERY_PREFIX,
    documentPrefix: "",
    duplicateThreshold: 0.9,
    searchFloor: { min: 0.5, relative: 0.88 },
  },
};

export interface Embedder {
  readonly spec: TierSpec;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

// Long memories add latency without improving a single-vector summary.
const MAX_EMBED_CHARS = 8000;

export function loadEmbedder(tier: EmbeddingTier, modelsDir: string): Promise<Embedder> {
  const spec = TIERS[tier];
  return spec.backend === "model2vec" ? loadModel2Vec(spec, modelsDir) : loadTransformers(spec, modelsDir);
}

async function loadModel2Vec(spec: TierSpec, modelsDir: string): Promise<Embedder> {
  const embedOne = loadStaticEmbedder(await ensureModelFiles({ modelsDir, model: spec.model }));
  return { spec, embed: async (texts) => texts.map((t) => embedOne(t.slice(0, MAX_EMBED_CHARS))) };
}

async function loadTransformers(spec: TierSpec, modelsDir: string): Promise<Embedder> {
  // Loaded on demand: it pulls in the onnxruntime-node native addon, which the zero tier must not
  // depend on (it can be missing or fail to load on some platforms).
  const transformers = await import("@huggingface/transformers");
  mkdirSync(modelsDir, { recursive: true });
  transformers.env.cacheDir = modelsDir;
  const extractor = await transformers.pipeline("feature-extraction", spec.model, { dtype: spec.dtype });
  return {
    spec,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const prefix = kind === "document" ? spec.documentPrefix : spec.queryPrefix;
      const output = await extractor(
        texts.map((t) => prefix + t.slice(0, MAX_EMBED_CHARS)),
        { pooling: spec.pooling, normalize: true },
      );
      const dims = output.dims.at(-1);
      if (dims !== spec.dims || !(output.data instanceof Float32Array)) {
        throw new Error(`${spec.model} returned ${dims} dims, expected ${spec.dims} float32`);
      }
      const data = output.data;
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    },
  };
}

const STATIC_FILES = ["model.safetensors", "tokenizer.json"] as const;

export async function ensureModelFiles(input: {
  modelsDir: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const dir = join(input.modelsDir, input.model.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  const doFetch = input.fetchImpl ?? fetch;
  for (const file of STATIC_FILES) {
    const target = join(dir, file);
    if (existsSync(target)) continue;
    const url = `https://huggingface.co/${input.model}/resolve/main/${file}`;
    const response = await doFetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const partial = `${target}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, target);
  }
  return dir;
}

export function loadStaticEmbedder(dir: string): (text: string) => Float32Array {
  const tokenizer = new WordPieceTokenizer(
    JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as TokenizerJson,
  );
  const table = readEmbeddingTable(join(dir, "model.safetensors"));
  return (text) => {
    const vector = new Float32Array(table.dims);
    if (addTokenVectors(vector, table, tokenizer.encode(text)) > 0) normalizeInPlace(vector);
    return vector;
  };
}

interface EmbeddingTable {
  weights: Float32Array;
  vocabSize: number;
  dims: number;
}

// model2vec ships one F32 tensor [vocab, dims] in a safetensors file.
function readEmbeddingTable(path: string): EmbeddingTable {
  const buf = readFileSync(path);
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString("utf8")) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const entry = Object.entries(header).find(([key]) => key !== "__metadata__");
  if (!entry) throw new Error("safetensors file has no tensors");
  const [, meta] = entry;
  const [vocabSize, dims] = meta.shape;
  if (meta.dtype !== "F32" || vocabSize === undefined || dims === undefined) {
    throw new Error(`unsupported embedding tensor ${meta.dtype} ${JSON.stringify(meta.shape)}`);
  }
  const start = buf.byteOffset + 8 + headerLength + meta.data_offsets[0];
  return {
    weights: new Float32Array(buf.buffer.slice(start, start + vocabSize * dims * 4)),
    vocabSize,
    dims,
  };
}

// Sums the static vector of every known token into `vector`; returns how many were added.
function addTokenVectors(vector: Float32Array, table: EmbeddingTable, ids: number[]): number {
  let count = 0;
  for (const id of ids) {
    if (id < 0 || id >= table.vocabSize) continue;
    const row = table.weights.subarray(id * table.dims, (id + 1) * table.dims);
    for (const [j, weight] of row.entries()) vector[j] = (vector[j] ?? 0) + weight;
    count++;
  }
  return count;
}

function normalizeInPlace(vector: Float32Array): void {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const [j, x] of vector.entries()) vector[j] = x / norm;
}

interface TokenizerJson {
  normalizer?: { lowercase?: boolean; strip_accents?: boolean | null } | null;
  model: {
    type: string;
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
}

// BERT basic tokenizer + greedy WordPiece. Matches HF BertNormalizer/BertPreTokenizer for
// the uncased vocabularies potion models use. Unknown words are dropped (model2vec behavior).
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly prefix: string;
  private readonly maxChars: number;
  private readonly lowercase: boolean;
  private readonly stripAccents: boolean;

  constructor(json: TokenizerJson) {
    if (json.model.type !== "WordPiece") throw new Error(`unsupported tokenizer ${json.model.type}`);
    this.vocab = new Map(Object.entries(json.model.vocab));
    this.prefix = json.model.continuing_subword_prefix ?? "##";
    this.maxChars = json.model.max_input_chars_per_word ?? 100;
    this.lowercase = json.normalizer?.lowercase ?? true;
    const strip = json.normalizer?.strip_accents;
    this.stripAccents = strip === null || strip === undefined ? this.lowercase : strip;
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    for (const word of this.preTokenize(this.normalize(text))) {
      for (const id of this.wordPiece(word)) ids.push(id);
    }
    return ids;
  }

  private normalize(text: string): string {
    let out = "";
    for (const ch of text) out += normalizeChar(ch);
    if (this.lowercase) out = out.toLowerCase();
    if (this.stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
    return out;
  }

  private preTokenize(text: string): string[] {
    return text.match(/[^\s\p{P}\p{S}]+|[\p{P}\p{S}]/gu) ?? [];
  }

  // Greedy longest-match-first; a word with any unmatched remainder yields no ids.
  private wordPiece(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > this.maxChars) return [];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      const piece = this.longestPiece(chars, start);
      if (!piece) return [];
      out.push(piece.id);
      start = piece.end;
    }
    return out;
  }

  private longestPiece(chars: string[], start: number): { id: number; end: number } | null {
    for (let end = chars.length; end > start; end--) {
      const id = this.vocab.get((start > 0 ? this.prefix : "") + chars.slice(start, end).join(""));
      if (id !== undefined) return { id, end };
    }
    return null;
  }
}

// BertNormalizer per character: drop NUL, U+FFFD and control characters, pad CJK ideographs
// with spaces, and map every whitespace character to a space.
function normalizeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0 || cp === 0xfffd || isControl(ch)) return "";
  if (isChinese(cp)) return ` ${ch} `;
  return /\s/.test(ch) ? " " : ch;
}

function isControl(ch: string): boolean {
  if (ch === "\t" || ch === "\n" || ch === "\r") return false;
  return /\p{Cc}|\p{Cf}/u.test(ch);
}

function isChinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}
