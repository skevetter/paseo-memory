import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder, TierSpec } from "../service/embedder";
import type { ProjectRef } from "../service/store";
import { sha256 } from "../service/text";

export const dataRepo: ProjectRef = {
  key: "remote:gitlab.com/h3upperbounds/data/data-team",
  name: "data/data-team",
  rootPath: "/home/u/h3/data-team",
  paseoProjectId: "prj_aaaa",
};

export const otherRepo: ProjectRef = {
  key: "remote:github.com/skevetter/devsy",
  name: "skevetter/devsy",
  rootPath: "/Users/u/devsy",
  paseoProjectId: "prj_bbbb",
};

export function tempDir(prefix = "pm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function hashSpec(model: string, dims: number): TierSpec {
  return {
    tier: "zero",
    model,
    backend: "model2vec",
    dtype: "fp32",
    pooling: "mean",
    dims,
    queryPrefix: "",
    documentPrefix: "",
    duplicateThreshold: 0.9,
    searchFloor: { min: 0.2, relative: 0.5 },
  };
}

export function hashEmbedder(model = "test/hash", dims = 64): Embedder & { calls: number } {
  const embedder = {
    spec: hashSpec(model, dims),
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += texts.length;
      return texts.map((text) => {
        const vector = new Float32Array(dims);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const slot = Number.parseInt(sha256(word).slice(0, 8), 16) % dims;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((x) => x / norm);
      });
    },
  };
  return embedder;
}
