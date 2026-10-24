import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export interface ModelArtifact {
  readonly path: string;
  readonly revision: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ModelManifest {
  readonly model: string;
  readonly modelRevision: string;
  readonly tokenizerRevision: string;
  readonly artifacts: readonly ModelArtifact[];
}

export interface ModelRuntimeIdentity {
  readonly implementation: "paseo-model2vec-v1" | "transformers.js";
  readonly transformers: string | null;
  readonly transformersSha256: string | null;
  readonly tokenizers: string | null;
  readonly onnxruntimeNode: string | null;
  readonly onnxruntimeCommon: string | null;
  readonly engine: "bun" | "node";
  readonly engineVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly unicode: string | null;
  readonly icu: string | null;
  readonly executionProvider: "cpu" | null;
}

export interface ModelPreprocessing {
  readonly task: "embedding" | "reranking";
  readonly implementation: string;
  readonly dtype: "fp32" | "q8";
  readonly dims: number;
  readonly pooling: "cls" | "mean" | "none";
  readonly normalization: "l2" | "none";
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  readonly maxInputChars: number | null;
  readonly maxDocumentChars: number | null;
  readonly maxPairTokens: number | null;
  readonly padding: boolean;
  readonly truncation: boolean;
  readonly scoreTransform: "none" | "sigmoid";
}

export interface ModelIdentity extends ModelManifest {
  readonly schemaVersion: 1;
  readonly runtime: Readonly<ModelRuntimeIdentity>;
  readonly preprocessing: Readonly<ModelPreprocessing>;
}

export class ModelArtifactError extends Error {
  constructor(
    readonly code: "model_manifest_invalid" | "model_artifact_invalid" | "model_download_failed",
    message: string,
  ) {
    super(message);
    this.name = "ModelArtifactError";
  }
}

const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_ARTIFACTS = 16;

export function defineModelManifest(input: ModelManifest): Readonly<ModelManifest> {
  const modelParts = input.model.split("/");
  if (modelParts.length !== 2 || !modelParts.every((part) => SEGMENT.test(part))) {
    throw invalidManifest("model must be an explicit owner/repository ID");
  }
  if (!REVISION.test(input.modelRevision) || !REVISION.test(input.tokenizerRevision)) {
    throw invalidManifest("model and tokenizer revisions must be full immutable commit hashes");
  }
  if (input.artifacts.length === 0 || input.artifacts.length > MAX_ARTIFACTS) {
    throw invalidManifest("artifact allowlist must contain 1-16 files");
  }
  const artifacts = input.artifacts.map((artifact) => checkedArtifact(input, artifact));
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  validateDistinctPaths(artifacts);
  return Object.freeze({
    model: input.model,
    modelRevision: input.modelRevision,
    tokenizerRevision: input.tokenizerRevision,
    artifacts: Object.freeze(artifacts),
  });
}

function invalidManifest(message: string): ModelArtifactError {
  return new ModelArtifactError("model_manifest_invalid", message);
}

function checkedArtifact(manifest: ModelManifest, artifact: ModelArtifact): Readonly<ModelArtifact> {
  const parts = artifact.path.split("/");
  if (parts.length > 4 || !parts.every((part) => SEGMENT.test(part))) {
    throw invalidManifest(`unsafe artifact path: ${artifact.path}`);
  }
  if (artifact.revision !== manifest.modelRevision && artifact.revision !== manifest.tokenizerRevision) {
    throw invalidManifest(`unlisted artifact revision: ${artifact.path}`);
  }
  if (!SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw invalidManifest(`invalid SHA256 or byte size: ${artifact.path}`);
  }
  return Object.freeze({
    path: artifact.path,
    revision: artifact.revision,
    sha256: artifact.sha256,
    size: artifact.size,
  });
}

function validateDistinctPaths(artifacts: readonly ModelArtifact[]): void {
  const paths = new Set(artifacts.map((artifact) => artifact.path));
  if (paths.size !== artifacts.length) throw invalidManifest("duplicate artifact path");
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (paths.has(parent)) throw invalidManifest(`artifact is also a directory: ${parent}`);
      parent = dirname(parent);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function modelIdentityJson(identity: ModelIdentity): string {
  return canonicalJson({ ...identity, ...defineModelManifest(identity) });
}

export function modelManifestFingerprint(manifest: ModelManifest): string {
  return canonicalHash(defineModelManifest(manifest));
}

export function modelIdentityFingerprint(identity: ModelIdentity): string {
  return createHash("sha256").update(modelIdentityJson(identity)).digest("hex");
}

export function modelArtifactDirectory(modelsDir: string, manifest: ModelManifest): string {
  return join(
    resolve(modelsDir),
    "verified",
    manifest.model.replace("/", "__"),
    `${manifest.modelRevision}-${modelManifestFingerprint(manifest)}`,
  );
}

interface PackageMetadata {
  entry: string;
  version: string;
}

function packageMetadata(name: string, from: NodeJS.Require): PackageMetadata {
  const entry = from.resolve(name);
  let dir = dirname(entry);
  for (;;) {
    const version = readPackageVersion(dir, name);
    if (version !== null) return { entry, version };
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot identify installed runtime package ${name}`);
    dir = parent;
  }
}

function readPackageVersion(dir: string, name: string): string | null {
  try {
    const metadata = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return metadata.name === name && typeof metadata.version === "string" ? metadata.version : null;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return null;
  }
}

let transformerRuntime: Readonly<ModelRuntimeIdentity> | undefined;

function runtimeIdentity(isStatic: boolean): Readonly<ModelRuntimeIdentity> {
  if (!isStatic && transformerRuntime) return transformerRuntime;
  const base = {
    engine: process.versions.bun ? ("bun" as const) : ("node" as const),
    engineVersion: process.versions.bun ?? process.versions.node,
    platform: process.platform,
    arch: process.arch,
    unicode: process.versions.unicode ?? null,
    icu: process.versions.icu ?? null,
  };
  if (isStatic) {
    return Object.freeze({
      ...base,
      implementation: "paseo-model2vec-v1",
      transformers: null,
      transformersSha256: null,
      tokenizers: null,
      onnxruntimeNode: null,
      onnxruntimeCommon: null,
      executionProvider: null,
    });
  }
  // Read installed metadata/code without loading ONNX; the entry hash also identifies bundled tokenizer code.
  const transformers = packageMetadata("@huggingface/transformers", createRequire(import.meta.url));
  const fromTransformers = createRequire(transformers.entry);
  const tokenizers = packageMetadata("@huggingface/tokenizers", fromTransformers);
  const onnx = packageMetadata("onnxruntime-node", fromTransformers);
  const common = packageMetadata("onnxruntime-common", createRequire(onnx.entry));
  transformerRuntime = Object.freeze({
    ...base,
    implementation: "transformers.js",
    transformers: transformers.version,
    transformersSha256: createHash("sha256")
      .update(readFileSync(new URL(import.meta.resolve("@huggingface/transformers"))))
      .digest("hex"),
    tokenizers: tokenizers.version,
    onnxruntimeNode: onnx.version,
    onnxruntimeCommon: common.version,
    executionProvider: "cpu",
  });
  return transformerRuntime;
}

export function createModelIdentity(
  manifest: ModelManifest,
  preprocessing: ModelPreprocessing,
): Readonly<ModelIdentity> {
  const pinned = defineModelManifest(manifest);
  return Object.freeze({
    schemaVersion: 1,
    ...pinned,
    runtime: runtimeIdentity(preprocessing.implementation === "paseo-wordpiece-sum-l2-v1"),
    preprocessing: Object.freeze({ ...preprocessing }),
  });
}

export async function loadLocalTransformers() {
  // Zero-tier callers never execute this import, even if the native addon is unavailable.
  const transformers = await import("@huggingface/transformers");
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.useFSCache = false;
  transformers.env.useBrowserCache = false;
  transformers.env.useCustomCache = false;
  return transformers;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function artifactDirectories(manifest: ModelManifest): string[] {
  const dirs = new Set<string>(["."]);
  for (const artifact of manifest.artifacts) {
    let dir = dirname(artifact.path);
    while (dir !== ".") {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  return [...dirs].sort((a, b) => a.length - b.length);
}

async function verifyArtifactTree(dir: string, manifest: ModelManifest): Promise<void> {
  const root = await lstat(dir);
  if (!root.isDirectory()) throw invalidArtifact("model root is not a directory");
  const files = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const dirs = new Set(artifactDirectories(manifest));
  const seen = new Set<string>();
  for (const relative of dirs) {
    await verifyDirectoryEntries({ dir, relative, files, dirs, seen });
  }
  if (seen.size !== files.size) throw invalidArtifact("incomplete model artifact set");
}

async function verifyDirectoryEntries(input: {
  dir: string;
  relative: string;
  files: ReadonlyMap<string, ModelArtifact>;
  dirs: ReadonlySet<string>;
  seen: Set<string>;
}): Promise<void> {
  const { dir, relative, files, dirs, seen } = input;
  const entries = await readdir(join(dir, relative), { withFileTypes: true });
  for (const entry of entries) {
    const path = relative === "." ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory() && dirs.has(path)) continue;
    if (!files.has(path) || !entry.isFile())
      throw invalidArtifact(`unlisted or non-regular artifact: ${path}`);
    seen.add(path);
  }
}

function invalidArtifact(message: string): ModelArtifactError {
  return new ModelArtifactError("model_artifact_invalid", message);
}

async function verifyArtifactFile(dir: string, artifact: ModelArtifact): Promise<void> {
  const file = await open(join(dir, artifact.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== artifact.size) throw invalidArtifact(`wrong size: ${artifact.path}`);
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw invalidArtifact(`SHA256 mismatch: ${artifact.path}`);
  } finally {
    await file.close();
  }
}

export async function verifyModelArtifacts(dir: string, manifest: ModelManifest): Promise<void> {
  const pinned = defineModelManifest(manifest);
  try {
    await verifyArtifactTree(dir, pinned);
    for (const artifact of pinned.artifacts) await verifyArtifactFile(dir, artifact);
  } catch (error) {
    if (error instanceof ModelArtifactError) throw error;
    throw invalidArtifact(`cannot verify model artifacts: ${error instanceof Error ? error.message : error}`);
  }
}

export type ModelArtifactFetch = (url: string, options: { redirect: "follow" }) => Promise<Response>;

async function downloadArtifact(input: {
  dir: string;
  manifest: ModelManifest;
  artifact: ModelArtifact;
  fetchImpl: ModelArtifactFetch;
}): Promise<void> {
  const { dir, manifest, artifact, fetchImpl } = input;
  const url = `https://huggingface.co/${manifest.model}/resolve/${artifact.revision}/${artifact.path}`;
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ModelArtifactError("model_download_failed", `${artifact.path}: HTTP ${response.status}`);
  }
  const target = join(dir, artifact.path);
  await mkdir(dirname(target), { recursive: true });
  const file = await open(target, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > artifact.size) throw invalidArtifact(`oversized download: ${artifact.path}`);
      hash.update(value);
      await file.writeFile(value);
    }
    if (size !== artifact.size || hash.digest("hex") !== artifact.sha256) {
      throw invalidArtifact(`download size or SHA256 mismatch: ${artifact.path}`);
    }
    await file.sync();
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}

async function sealArtifacts(dir: string, manifest: ModelManifest): Promise<void> {
  for (const artifact of manifest.artifacts) await chmod(join(dir, artifact.path), 0o444);
  for (const path of artifactDirectories(manifest).reverse()) await chmod(join(dir, path), 0o555);
}

async function discardStaging(dir: string, manifest: ModelManifest): Promise<void> {
  if (!(await exists(dir))) return;
  for (const path of artifactDirectories(manifest)) {
    await chmod(join(dir, path), 0o700).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
  await rm(dir, { recursive: true, force: true });
}

async function activateStaging(staging: string, target: string, manifest: ModelManifest): Promise<void> {
  if (await exists(target)) {
    await verifyModelArtifacts(target, manifest);
    return;
  }
  try {
    await rename(staging, target);
  } catch (error) {
    // macOS can report EACCES for a concurrent sealed-directory winner, not just EEXIST/ENOTEMPTY.
    // Converge only on an existing fully verified target; preserve genuine permission failures.
    if (!(await exists(target))) throw error;
    await verifyModelArtifacts(target, manifest);
  }
}

export async function ensureModelArtifacts(input: {
  modelsDir: string;
  manifest: ModelManifest;
  fetchImpl?: ModelArtifactFetch;
}): Promise<string> {
  const manifest = defineModelManifest(input.manifest);
  const target = modelArtifactDirectory(input.modelsDir, manifest);
  if (await exists(target)) {
    await verifyModelArtifacts(target, manifest);
    return target;
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".staging-"));
  try {
    for (const artifact of manifest.artifacts) {
      await downloadArtifact({ dir: staging, manifest, artifact, fetchImpl: input.fetchImpl ?? fetch });
    }
    await verifyArtifactTree(staging, manifest);
    await sealArtifacts(staging, manifest);
    await activateStaging(staging, target, manifest);
    return target;
  } finally {
    await discardStaging(staging, manifest);
  }
}

function pinnedManifest(
  model: string,
  revision: string,
  artifacts: readonly Omit<ModelArtifact, "revision">[],
): Readonly<ModelManifest> {
  return defineModelManifest({
    model,
    modelRevision: revision,
    tokenizerRevision: revision,
    artifacts: artifacts.map((artifact) => ({ ...artifact, revision })),
  });
}

// Primary sources: https://huggingface.co/api/models/{model}?blobs=true (2026-10-23).
// LFS SHA256/size are upstream metadata; JSON SHA256 is from the exact pinned resolve bytes.
// Medium/reranker config, tokenizer and q8 weights also match the pre-M06 installed cache byte-for-byte.
export const MODEL_MANIFESTS = Object.freeze({
  zero: pinnedManifest("minishlab/potion-base-8M", "bf8b056651a2c21b8d2565580b8569da283cab23", [
    {
      path: "model.safetensors",
      size: 30236760,
      sha256: "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
    },
    {
      path: "tokenizer.json",
      size: 683666,
      sha256: "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
    },
  ]),
  low: pinnedManifest("Xenova/bge-small-en-v1.5", "ea104dacec62c0de699686887e3f920caeb4f3e3", [
    {
      path: "config.json",
      size: 683,
      sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
    },
    {
      path: "tokenizer.json",
      size: 711396,
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    },
    {
      path: "tokenizer_config.json",
      size: 366,
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 34014426,
      sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
    },
  ]),
  medium: pinnedManifest("Alibaba-NLP/gte-modernbert-base", "e7f32e3c00f91d699e8c43b53106206bcc72bb22", [
    {
      path: "config.json",
      size: 1184,
      sha256: "8ba54dc3d35d7194f5178a4194b649f146753e02dabd22bdca5c5cbac15069ed",
    },
    {
      path: "tokenizer.json",
      size: 3583228,
      sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30",
    },
    {
      path: "tokenizer_config.json",
      size: 20867,
      sha256: "9654072f7c873161814043cf08cb5ed72f71d0b935abcd4e267935cb34352c21",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 150218016,
      sha256: "bae96b276d342bf86eeee07c1bdbc0c75bb82bf4033941aab7fabc1e33ee3b44",
    },
  ]),
  high: pinnedManifest("Xenova/bge-large-en-v1.5", "dfeef6070b90658e1b391a6940efdb0925c1de6f", [
    {
      path: "config.json",
      size: 719,
      sha256: "7bd757258c7418221da95ff1853bae50ef5d1bee3e8c01a96611243a52aa7299",
    },
    {
      path: "tokenizer.json",
      size: 711396,
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    },
    {
      path: "tokenizer_config.json",
      size: 366,
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 336983162,
      sha256: "4842b56e233be1cc74770f57f63b1ebb6cf357cca3dd73fcdec35c019f8a5d6e",
    },
  ]),
  reranker: pinnedManifest(
    "Alibaba-NLP/gte-reranker-modernbert-base",
    "f7481e6055501a30fb19d090657df9ec1f79ab2c",
    [
      {
        path: "config.json",
        size: 1333,
        sha256: "c9316ff715158502dad782f35454eee18de984160618dc30afe7508feb46b7ce",
      },
      {
        path: "tokenizer.json",
        size: 3583499,
        sha256: "2aea6ff4701d063e7e029b6be695a1659f2caaa2ae4fb0e8b18285818271becd",
      },
      {
        path: "tokenizer_config.json",
        size: 21031,
        sha256: "626c86908d7c711f93b0feffd8657b782cc2727b391f9be190240e8cafb626d5",
      },
      {
        path: "onnx/model_quantized.onnx",
        size: 150871837,
        sha256: "ecc6a0ae67cee3d898167802383112d9185ca9250e07bd5d1fa65019b050179d",
      },
    ],
  ),
});
