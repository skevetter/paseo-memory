import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TIERS } from "../service/embedder";
import type { ModelArtifactFetch, ModelIdentity, ModelManifest } from "../service/model-manifest";
import {
  createModelIdentity,
  defineModelManifest,
  ensureModelArtifacts,
  ModelArtifactError,
  modelArtifactDirectory,
  modelIdentityFingerprint,
  modelManifestFingerprint,
  verifyModelArtifacts,
} from "../service/model-manifest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeDirectoriesWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-model-manifest-"));
  roots.push(root);
  return root;
}

function makeDirectoriesWritable(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeDirectoriesWritable(join(dir, entry.name));
  }
}

function artifactFixture(revision = "a".repeat(40)) {
  // Synthetic bytes exercise storage integrity, never model quality.
  const contents = {
    "config.json": '{"model_type":"bert"}',
    "onnx/model_quantized.onnx": "synthetic quantized artifact",
    "tokenizer.json": '{"model":{"type":"WordPiece","vocab":{"hello":0}}}',
    "tokenizer_config.json": '{"model_max_length":512}',
  } satisfies Record<string, string>;
  const manifest = defineModelManifest({
    model: "fixture/immutable-model",
    modelRevision: revision,
    tokenizerRevision: revision,
    artifacts: Object.entries(contents).map(([path, text]) => ({
      path,
      revision,
      sha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
    })),
  });
  const files: Readonly<Record<string, string>> = contents;
  const fetchImpl: ModelArtifactFetch = async (url) => {
    const artifact = manifest.artifacts.find(
      (file) => url === `https://huggingface.co/${manifest.model}/resolve/${file.revision}/${file.path}`,
    );
    if (!artifact) throw new Error(`unexpected artifact URL: ${url}`);
    const text = files[artifact.path];
    if (text === undefined) throw new Error(`missing artifact fixture: ${artifact.path}`);
    return new Response(text);
  };
  return { manifest, contents, fetchImpl };
}

function populate(dir: string, contents: Record<string, string>): void {
  for (const [path, text] of Object.entries(contents)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function failedArtifactResponse(failure: string, bytes: string): Response {
  switch (failure) {
    case "truncated":
      return new Response(bytes.slice(1));
    case "oversized":
      return new Response(`${bytes}!`);
    case "wrong-digest":
      return new Response("x".repeat(Buffer.byteLength(bytes)));
    case "unavailable":
      return new Response("unavailable", { status: 503 });
    case "interrupted":
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("interrupted artifact stream"));
          },
        }),
      );
    default:
      throw new Error(`unknown download failure: ${failure}`);
  }
}

describe("immutable artifact activation", () => {
  it("publishes the complete verified set atomically and reuses it without network access", async () => {
    const modelsDir = scratch();
    const fixture = artifactFixture();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const target = modelArtifactDirectory(modelsDir, fixture.manifest);
    const fetchImpl: ModelArtifactFetch = async (url, options) => {
      if (url.endsWith("/tokenizer_config.json")) {
        started.resolve();
        await gate.promise;
      }
      return fixture.fetchImpl(url, options);
    };
    const pending = ensureModelArtifacts({ modelsDir, manifest: fixture.manifest, fetchImpl });
    await started.promise;
    try {
      expect(existsSync(target)).toBe(false);
    } finally {
      gate.resolve();
    }
    expect(await pending).toBe(target);
    for (const [path, expected] of Object.entries(fixture.contents)) {
      expect(readFileSync(join(target, path), "utf8")).toBe(expected);
      expect(statSync(join(target, path)).mode & 0o222).toBe(0);
    }
    await verifyModelArtifacts(target, fixture.manifest);
    const cached = await ensureModelArtifacts({
      modelsDir,
      manifest: fixture.manifest,
      fetchImpl: async () => {
        throw new Error("verified artifacts must not be downloaded again");
      },
    });
    expect(cached).toBe(target);
    expect(readdirSync(dirname(target))).toEqual([basename(target)]);
  });

  it("allows concurrent activators to converge without partial or mixed artifact sets", async () => {
    const modelsDir = scratch();
    const fixture = artifactFixture();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let arrivals = 0;
    const fetchImpl: ModelArtifactFetch = async (url, options) => {
      if (url.endsWith("/config.json")) {
        arrivals++;
        if (arrivals === 2) started.resolve();
        await gate.promise;
      }
      return fixture.fetchImpl(url, options);
    };
    const input = { modelsDir, manifest: fixture.manifest, fetchImpl };
    const first = ensureModelArtifacts(input);
    const second = ensureModelArtifacts(input);
    await started.promise;
    gate.resolve();
    const target = modelArtifactDirectory(modelsDir, fixture.manifest);
    expect(await Promise.all([first, second])).toEqual([target, target]);
    await verifyModelArtifacts(target, fixture.manifest);
    expect(readdirSync(dirname(target))).toEqual([basename(target)]);
    expect(readFileSync(join(target, "onnx/model_quantized.onnx"), "utf8")).toBe(
      fixture.contents["onnx/model_quantized.onnx"],
    );
  });
});

describe("artifact download failures", () => {
  it.each(["truncated", "oversized", "wrong-digest", "unavailable", "interrupted"])(
    "refuses a %s download while preserving the prior active revision",
    async (failure) => {
      const modelsDir = scratch();
      const old = artifactFixture();
      const prior = await ensureModelArtifacts({
        modelsDir,
        manifest: old.manifest,
        fetchImpl: old.fetchImpl,
      });
      const next = artifactFixture("b".repeat(40));
      const fetchImpl: ModelArtifactFetch = async (url, options) => {
        if (!url.endsWith("/onnx/model_quantized.onnx")) return next.fetchImpl(url, options);
        const bytes = next.contents["onnx/model_quantized.onnx"];
        return failedArtifactResponse(failure, bytes);
      };
      await expect(ensureModelArtifacts({ modelsDir, manifest: next.manifest, fetchImpl })).rejects.toThrow();
      expect(existsSync(modelArtifactDirectory(modelsDir, next.manifest))).toBe(false);
      await verifyModelArtifacts(prior, old.manifest);
      expect(readFileSync(join(prior, "onnx/model_quantized.onnx"), "utf8")).toBe(
        old.contents["onnx/model_quantized.onnx"],
      );
      expect(readdirSync(dirname(prior))).toEqual([basename(prior)]);
    },
  );
});

describe("activation conflict isolation", () => {
  it("refuses a corrupt competing target without replacing it or a valid prior revision", async () => {
    const modelsDir = scratch();
    const old = artifactFixture();
    const prior = await ensureModelArtifacts({ modelsDir, manifest: old.manifest, fetchImpl: old.fetchImpl });
    const next = artifactFixture("b".repeat(40));
    const target = modelArtifactDirectory(modelsDir, next.manifest);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const fetchImpl: ModelArtifactFetch = async (url, options) => {
      if (url.endsWith("/tokenizer_config.json")) {
        started.resolve();
        await gate.promise;
      }
      return next.fetchImpl(url, options);
    };
    const pending = ensureModelArtifacts({ modelsDir, manifest: next.manifest, fetchImpl });
    await started.promise;
    try {
      populate(target, { "config.json": "corrupt competing target" });
    } finally {
      gate.resolve();
    }
    await expect(pending).rejects.toMatchObject({ code: "model_artifact_invalid" });
    expect(readFileSync(join(target, "config.json"), "utf8")).toBe("corrupt competing target");
    await verifyModelArtifacts(prior, old.manifest);
    expect(readFileSync(join(prior, "onnx/model_quantized.onnx"), "utf8")).toBe(
      old.contents["onnx/model_quantized.onnx"],
    );
    expect(readdirSync(dirname(prior)).sort()).toEqual([basename(prior), basename(target)].sort());
  });
});

describe("immutable artifact validation", () => {
  it("refuses a corrupt immutable cache instead of trusting existence or silently replacing it", async () => {
    const modelsDir = scratch();
    const fixture = artifactFixture();
    const target = await ensureModelArtifacts({
      modelsDir,
      manifest: fixture.manifest,
      fetchImpl: fixture.fetchImpl,
    });
    const weights = join(target, "onnx/model_quantized.onnx");
    chmodSync(weights, 0o600);
    const corruption = "x".repeat(statSync(weights).size);
    writeFileSync(weights, corruption);
    let downloads = 0;
    const fetchImpl: ModelArtifactFetch = async (url, options) => {
      downloads++;
      return fixture.fetchImpl(url, options);
    };
    await expect(
      ensureModelArtifacts({ modelsDir, manifest: fixture.manifest, fetchImpl }),
    ).rejects.toMatchObject({
      code: "model_artifact_invalid",
    });
    expect(downloads).toBe(0);
    expect(readFileSync(weights, "utf8")).toBe(corruption);
  });

  it("refuses an incomplete existing revision rather than filling it in place", async () => {
    const modelsDir = scratch();
    const fixture = artifactFixture();
    const target = modelArtifactDirectory(modelsDir, fixture.manifest);
    populate(target, { "config.json": fixture.contents["config.json"] ?? "" });
    await expect(
      ensureModelArtifacts({ modelsDir, manifest: fixture.manifest, fetchImpl: fixture.fetchImpl }),
    ).rejects.toMatchObject({ code: "model_artifact_invalid" });
    expect(readdirSync(target)).toEqual(["config.json"]);
    expect(existsSync(join(target, "onnx/model_quantized.onnx"))).toBe(false);
  });

  it("rejects an unlisted artifact, even when every allowed file is valid", async () => {
    const modelsDir = scratch();
    const fixture = artifactFixture();
    const target = modelArtifactDirectory(modelsDir, fixture.manifest);
    populate(target, fixture.contents);
    writeFileSync(join(target, "model.onnx"), "unlisted fallback weights");
    await expect(
      ensureModelArtifacts({ modelsDir, manifest: fixture.manifest, fetchImpl: fixture.fetchImpl }),
    ).rejects.toMatchObject({ code: "model_artifact_invalid" });
    expect(readFileSync(join(target, "model.onnx"), "utf8")).toBe("unlisted fallback weights");
  });
});

describe("artifact symlink rejection", () => {
  it.each(["root", "file", "directory"])("rejects an artifact %s symlink", async (kind) => {
    const modelsDir = scratch();
    const outside = scratch();
    const fixture = artifactFixture();
    const target = modelArtifactDirectory(modelsDir, fixture.manifest);
    populate(outside, fixture.contents);
    mkdirSync(dirname(target), { recursive: true });
    if (kind === "root") {
      symlinkSync(outside, target, "dir");
    } else {
      populate(target, fixture.contents);
      if (kind === "file") {
        unlinkSync(join(target, "tokenizer.json"));
        symlinkSync(join(outside, "tokenizer.json"), join(target, "tokenizer.json"));
      } else {
        rmSync(join(target, "onnx"), { recursive: true });
        symlinkSync(join(outside, "onnx"), join(target, "onnx"), "dir");
      }
    }
    await expect(
      ensureModelArtifacts({ modelsDir, manifest: fixture.manifest, fetchImpl: fixture.fetchImpl }),
    ).rejects.toMatchObject({ code: "model_artifact_invalid" });
    expect(readFileSync(join(outside, "onnx/model_quantized.onnx"), "utf8")).toBe(
      fixture.contents["onnx/model_quantized.onnx"],
    );
  });
});

describe("manifest and index input identity", () => {
  it.each(["main", "v1.0", "a".repeat(39), "a".repeat(41)])(
    "rejects mutable or abbreviated revision %s",
    (revision) => {
      const { manifest } = artifactFixture();
      expect(() => defineModelManifest({ ...manifest, modelRevision: revision })).toThrow(ModelArtifactError);
      expect(() => defineModelManifest({ ...manifest, tokenizerRevision: revision })).toThrow(
        ModelArtifactError,
      );
    },
  );

  it.each(["../escape", "onnx/../escape", "/absolute", "onnx\\escape", "onnx/%2e%2e/escape"])(
    "rejects unsafe allowlist path %s before downloading",
    async (path) => {
      const modelsDir = scratch();
      const { manifest } = artifactFixture();
      const artifact = manifest.artifacts[0];
      if (!artifact) throw new Error("fixture has no artifact");
      const invalid = { ...manifest, artifacts: [{ ...artifact, path }] };
      await expect(ensureModelArtifacts({ modelsDir, manifest: invalid })).rejects.toMatchObject({
        code: "model_manifest_invalid",
      });
      expect(readdirSync(modelsDir)).toEqual([]);
    },
  );

  it("rejects duplicate paths, file-directory collisions and invalid digests or byte sizes", () => {
    const { manifest } = artifactFixture();
    const artifact = manifest.artifacts[0];
    if (!artifact) throw new Error("fixture has no artifact");
    const invalid: ModelManifest[] = [
      { ...manifest, artifacts: [] },
      { ...manifest, artifacts: [artifact, artifact] },
      { ...manifest, artifacts: [artifact, { ...artifact, path: `${artifact.path}/nested` }] },
      { ...manifest, artifacts: [{ ...artifact, sha256: "a".repeat(40) }] },
      { ...manifest, artifacts: [{ ...artifact, size: Number.NaN }] },
      { ...manifest, artifacts: [{ ...artifact, size: 0 }] },
      { ...manifest, artifacts: [{ ...artifact, revision: "main" }] },
      { ...manifest, model: "../escape" },
    ];
    for (const input of invalid) expect(() => defineModelManifest(input)).toThrow(ModelArtifactError);
  });
});

describe("index input identity", () => {
  it("keeps identities stable across property and allowlist order but changes every inference input", () => {
    const identity = TIERS.zero.identity;
    const baseline = modelIdentityFingerprint(identity);
    const reordered = {
      preprocessing: { ...identity.preprocessing },
      runtime: { ...identity.runtime },
      artifacts: [...identity.artifacts].reverse(),
      tokenizerRevision: identity.tokenizerRevision,
      modelRevision: identity.modelRevision,
      model: identity.model,
      schemaVersion: identity.schemaVersion,
    };
    expect(modelIdentityFingerprint(reordered)).toBe(baseline);
    const variants: ModelIdentity[] = [
      { ...identity, tokenizerRevision: "b".repeat(40) },
      {
        ...identity,
        modelRevision: "b".repeat(40),
        artifacts: identity.artifacts.map((artifact) => ({ ...artifact, revision: "b".repeat(40) })),
      },
      {
        ...identity,
        artifacts: identity.artifacts.map((artifact) => ({ ...artifact, sha256: "b".repeat(64) })),
      },
      { ...identity, runtime: { ...identity.runtime, engineVersion: "different-engine" } },
      { ...identity, runtime: { ...identity.runtime, tokenizers: "different-tokenizer" } },
      { ...identity, runtime: { ...identity.runtime, onnxruntimeNode: "different-onnx" } },
      { ...identity, runtime: { ...identity.runtime, transformersSha256: "b".repeat(64) } },
      { ...identity, preprocessing: { ...identity.preprocessing, normalization: "none" } },
      { ...identity, preprocessing: { ...identity.preprocessing, dtype: "q8" } },
      { ...identity, preprocessing: { ...identity.preprocessing, pooling: "cls" } },
      { ...identity, preprocessing: { ...identity.preprocessing, queryPrefix: "different-prefix" } },
      { ...identity, preprocessing: { ...identity.preprocessing, maxInputChars: 4000 } },
      {
        ...identity,
        preprocessing: { ...identity.preprocessing, implementation: "different-preprocessing" },
      },
    ];
    for (const variant of variants) expect(modelIdentityFingerprint(variant)).not.toBe(baseline);
  });

  it("addresses artifact revisions separately and freezes caller-owned identity material", () => {
    const { manifest } = artifactFixture();
    const identity = createModelIdentity(manifest, TIERS.zero.identity.preprocessing);
    const before = modelIdentityFingerprint(identity);
    expect(() => Object.assign(identity, { modelRevision: "b".repeat(40) })).toThrow(TypeError);
    expect(() => Object.assign(identity.runtime, { engineVersion: "changed" })).toThrow(TypeError);
    expect(() => Object.assign(identity.preprocessing, { maxInputChars: 1 })).toThrow(TypeError);
    expect(() => Object.assign(identity.artifacts[0] ?? {}, { sha256: "b".repeat(64) })).toThrow(TypeError);
    expect(() => Object.assign(TIERS.zero, { dims: 1 })).toThrow(TypeError);
    expect(modelIdentityFingerprint(identity)).toBe(before);
    const revised = artifactFixture("b".repeat(40)).manifest;
    expect(modelArtifactDirectory("/models", revised)).not.toBe(modelArtifactDirectory("/models", manifest));
    const changedBytes = {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, sha256: "b".repeat(64) })),
    };
    expect(modelArtifactDirectory("/models", changedBytes)).not.toBe(
      modelArtifactDirectory("/models", manifest),
    );
    expect(modelManifestFingerprint({ ...manifest, artifacts: [...manifest.artifacts].reverse() })).toBe(
      modelManifestFingerprint(manifest),
    );
  });
});
