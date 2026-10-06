// Lightweight static embeddings (model2vec "potion" models) in pure TypeScript.
// No native code, no ONNX runtime: a WordPiece tokenizer plus a mean of token vectors.
// The model (~30 MB) downloads once into the plugin data directory on first use.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(text: string): Float32Array;
}

export type EmbedderState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; embedder: Embedder }
  | { status: "error"; error: string };

const DEFAULT_MODEL = "minishlab/potion-base-8M";
const FILES = ["model.safetensors", "tokenizer.json"] as const;

export async function ensureModelFiles(input: {
  modelsDir: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const model = input.model ?? DEFAULT_MODEL;
  const dir = join(input.modelsDir, model.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  const doFetch = input.fetchImpl ?? fetch;
  for (const file of FILES) {
    const target = join(dir, file);
    if (existsSync(target)) continue;
    const url = `https://huggingface.co/${model}/resolve/main/${file}`;
    const response = await doFetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const partial = `${target}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, target);
  }
  return dir;
}

export function loadStaticEmbedder(dir: string, model = DEFAULT_MODEL): Embedder {
  const tokenizer = new WordPieceTokenizer(
    JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as TokenizerJson,
  );
  const buf = readFileSync(join(dir, "model.safetensors"));
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString("utf8")) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const entry = Object.entries(header).find(([key]) => key !== "__metadata__");
  if (!entry) throw new Error("safetensors file has no tensors");
  const [, meta] = entry;
  if (meta.dtype !== "F32") throw new Error(`unsupported embedding dtype ${meta.dtype}`);
  const [vocabSize, dims] = meta.shape as [number, number];
  const start = 8 + headerLength + meta.data_offsets[0];
  const weights = new Float32Array(
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + vocabSize * dims * 4),
  );

  return {
    model,
    dims,
    embed(text: string): Float32Array {
      const ids = tokenizer.encode(text);
      const vector = new Float32Array(dims);
      let count = 0;
      for (const id of ids) {
        if (id < 0 || id >= vocabSize) continue;
        const offset = id * dims;
        for (let j = 0; j < dims; j++) vector[j] += weights[offset + j];
        count++;
      }
      if (count === 0) return vector;
      normalize(vector);
      return vector;
    },
  };
}

export function normalize(vector: Float32Array): void {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < vector.length; j++) vector[j] /= norm;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
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
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (isChinese(cp)) out += ` ${ch} `;
      else out += /\s/.test(ch) ? " " : ch;
    }
    if (this.lowercase) out = out.toLowerCase();
    if (this.stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
    return out;
  }

  private preTokenize(text: string): string[] {
    return text.match(/[^\s\p{P}\p{S}]+|[\p{P}\p{S}]/gu) ?? [];
  }

  private wordPiece(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > this.maxChars) return [];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? this.prefix : "") + chars.slice(start, end).join("");
        found = this.vocab.get(piece);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [];
      out.push(found);
      start = end;
    }
    return out;
  }
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
