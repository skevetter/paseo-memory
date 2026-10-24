import type { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import {
  type BridgeImportInput,
  BridgeImportInputSchema,
  type BridgeImportPreview,
  type BridgeImportPreviewInput,
  BridgeImportPreviewInputSchema,
  type BridgeImportResult,
  BridgeImportResultSchema,
} from "../shared/bridge-import";
import { type MemoryRef, MemoryRefSchema } from "../shared/lifecycle";
import {
  type MemoryNamespace,
  MemoryNamespaceSchema,
  namespaceColumns,
  namespaceKey,
} from "../shared/namespaces";
import { Access } from "./access";
import { BridgeFailure } from "./bridge-errors";
import {
  canonicalBody,
  MutationError,
  type MutationPrincipal,
  mutationRequestId,
  ownerMutation,
} from "./mutations";
import { redact } from "./redact";
import type { MemoryStore } from "./store";
import { sha256 } from "./text";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CANDIDATES = 128;
const MAX_FACT_CHARS = 4000;
const TITLE_CHARS = 80;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const BLANK = /^\s*$/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TokenPayloadSchema = z.strictObject({
  v: z.literal(1),
  paths: z.array(z.string().min(1).max(4096)).max(32),
  namespace: MemoryNamespaceSchema,
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      canonicalPath: z.string().min(1),
      sourceHash: Sha256Schema,
      bytes: z.number().int().nonnegative(),
    }),
  ),
  candidates: z.array(
    z.strictObject({
      sourceId: z.string().min(1),
      sourcePath: z.string().min(1),
      sourceHash: Sha256Schema,
      duplicate: MemoryRefSchema.nullable(),
    }),
  ),
  unsupported: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
  planDigest: Sha256Schema,
  expiresAt: z.number().int(),
});
type TokenPayload = z.infer<typeof TokenPayloadSchema>;

interface FileRecord {
  path: string;
  canonicalPath: string;
  sourceHash: string;
  bytes: number;
}
interface Candidate {
  sourceId: string;
  sourcePath: string;
  sourceHash: string;
  title: string;
  content: string;
  duplicate: MemoryRef | null;
}
interface Unsupported {
  path: string;
  reason: string;
}
interface Plan {
  files: FileRecord[];
  candidates: Candidate[];
  unsupported: Unsupported[];
}
interface Block {
  line: number;
  text: string;
}
interface Extracted {
  blocks: Block[];
  fences: string[];
}
interface Scan {
  db: Database;
  store: MemoryStore;
  namespace: MemoryNamespace;
  plan: Plan;
  keys: Set<string>;
}
type SourceRead = { raw: Buffer; canonicalPath: string } | { reason: string };
type Decoded = { text: string } | { reason: string };

export interface BridgeImportsOptions {
  db: Database;
  store: MemoryStore;
  secret: string;
  now: () => string;
}

// One-off owner import of explicit Markdown files as candidate facts.
// Writes must use the store's own connection: pass the same db handle.
export class BridgeImports {
  constructor(private readonly options: BridgeImportsOptions) {}

  preview(input: BridgeImportPreviewInput): BridgeImportPreview {
    const request = BridgeImportPreviewInputSchema.parse(input);
    const plan = buildPlan(this.options.store, this.options.db, request.paths, request.namespace);
    const payload: TokenPayload = {
      v: 1,
      paths: request.paths,
      namespace: request.namespace,
      files: plan.files,
      candidates: plan.candidates.map(({ sourceId, sourcePath, sourceHash, duplicate }) => ({
        sourceId,
        sourcePath,
        sourceHash,
        duplicate,
      })),
      unsupported: plan.unsupported,
      planDigest: planDigest(request.namespace, plan),
      expiresAt: Date.parse(this.options.now()) + TOKEN_TTL_MS,
    };
    return {
      previewToken: signToken(payload, this.options.secret),
      namespace: request.namespace,
      files: plan.files.map(({ path, sourceHash, bytes }) => ({ path, sourceHash, bytes })),
      candidates: plan.candidates,
      unsupported: plan.unsupported,
      counts: {
        candidates: plan.candidates.length,
        duplicates: plan.candidates.filter((candidate) => candidate.duplicate !== null).length,
        unsupported: plan.unsupported.length,
      },
    };
  }

  import(input: BridgeImportInput): BridgeImportResult {
    const request = BridgeImportInputSchema.parse(input);
    const payload = verifyToken(request.previewToken, this.options.secret);
    const bodyHash = sha256(canonicalBody(request));
    try {
      return this.options.db.transaction(() => this.commit(request, payload, bodyHash)).immediate();
    } catch (error) {
      throw mapError(error);
    }
  }

  private commit(request: BridgeImportInput, payload: TokenPayload, bodyHash: string): BridgeImportResult {
    const prior = this.options.db
      .query<{ body_hash: string; result_json: string }, [string]>(
        "SELECT body_hash,result_json FROM bridge_requests WHERE principal_id='owner' AND endpoint='import' AND request_id=?",
      )
      .get(request.importId);
    if (prior) {
      if (prior.body_hash !== bodyHash)
        throw new BridgeFailure("request_conflict", "importId was already used with a different request");
      return this.replay(prior.result_json, payload.namespace);
    }
    return this.fresh(request, payload, bodyHash);
  }

  private replay(resultJson: string, namespace: MemoryNamespace): BridgeImportResult {
    const result = BridgeImportResultSchema.parse(JSON.parse(resultJson));
    if (!result.memoryRefs.every((ref) => this.liveMemory(ref, namespace))) throw staleReplay();
    if (!result.sourceIds.every((sourceId) => this.liveSource(sourceId, namespace))) throw staleReplay();
    return result;
  }

  // Exact revision: any correction or move after import invalidates the receipt.
  // Candidate state is not checked; currentLifecycleSql would reject candidates.
  private liveMemory(ref: MemoryRef, namespace: MemoryNamespace): boolean {
    const row = this.options.db
      .query<
        {
          record_revision: number;
          scope: string;
          project_key: string | null;
          bot_id: string | null;
          deleted_at: string | null;
        },
        [number]
      >("SELECT record_revision,scope,project_key,bot_id,deleted_at FROM memories WHERE id=?")
      .get(ref.id);
    if (!row || row.deleted_at !== null || row.record_revision !== ref.revision) return false;
    const expected = namespaceColumns(namespace);
    if (
      row.scope !== expected.scope ||
      (row.project_key ?? null) !== expected.project_key ||
      (row.bot_id ?? null) !== expected.bot_id
    )
      return false;
    const tombstone = this.options.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM memory_tombstones WHERE kind='memory' AND identifier=?",
      )
      .get(String(ref.id));
    return (tombstone?.n ?? 0) === 0;
  }

  // Scoped artifact row (namespace is hashed into the source ID) plus source tombstones.
  private liveSource(sourceId: string, namespace: MemoryNamespace): boolean {
    const row = this.options.db
      .query<{ scope: string; project_key: string | null }, [string]>(
        "SELECT scope,project_key FROM source_artifacts WHERE source_ref=?",
      )
      .get(sourceId);
    if (!row) return false;
    const expected = namespaceColumns(namespace);
    if (row.scope !== expected.scope || (row.project_key ?? null) !== expected.project_key) return false;
    return !this.options.store.provenance.sourceTombstoned(sourceId);
  }

  private fresh(request: BridgeImportInput, payload: TokenPayload, bodyHash: string): BridgeImportResult {
    if (Date.parse(this.options.now()) > payload.expiresAt)
      throw new BridgeFailure("lease_expired", "Preview token expired; run a fresh preview");
    const plan = buildPlan(this.options.store, this.options.db, payload.paths, payload.namespace);
    if (planDigest(payload.namespace, plan) !== payload.planDigest)
      throw new BridgeFailure("revision_conflict", "Preview is stale; run a fresh preview");
    const known = new Set(plan.candidates.map((candidate) => candidate.sourceId));
    if (!request.approvedSourceIds.every((sourceId) => known.has(sourceId)))
      throw new BridgeFailure("request_conflict", "Approved source is not in the preview");
    const result = this.writeApproved(payload.namespace, plan.candidates, new Set(request.approvedSourceIds));
    this.options.db
      .query(
        "INSERT INTO bridge_requests(principal_id,endpoint,request_id,body_hash,result_json,created_at) VALUES('owner','import',?,?,?,?)",
      )
      .run(request.importId, bodyHash, JSON.stringify(result), this.options.now());
    return result;
  }

  private writeApproved(
    namespace: MemoryNamespace,
    candidates: Candidate[],
    approved: Set<string>,
  ): BridgeImportResult {
    const owner = Access.owner();
    const result: BridgeImportResult = { proposed: 0, duplicates: 0, memoryRefs: [], sourceIds: [] };
    for (const candidate of candidates) {
      if (!approved.has(candidate.sourceId)) continue;
      if (candidate.duplicate) {
        result.duplicates += 1;
        continue;
      }
      result.proposed += 1;
      result.memoryRefs.push(this.propose(owner, namespace, candidate));
      result.sourceIds.push(candidate.sourceId);
    }
    return result;
  }

  private propose(owner: Access, namespace: MemoryNamespace, candidate: Candidate): MemoryRef {
    const { store } = this.options;
    store.provenance.registerArtifact(owner, {
      sourceRef: candidate.sourceId,
      content: candidate.content,
      scope: namespace.kind,
      projectKey: namespace.kind === "project" ? namespace.projectKey : null,
      botId: namespace.kind === "bot" ? namespace.botId : null,
      allowExcerpt: false,
    });
    const principal: MutationPrincipal = { ...ownerMutation(owner), defaultNamespace: namespace };
    const result = store.mutations.mutate(principal, {
      requestId: mutationRequestId(),
      operation: "propose",
      evidence: [{ sourceKind: "artifact", sourceRef: candidate.sourceId, includeExcerpt: false }],
      change: {
        title: candidate.title,
        content: candidate.content,
        type: "note",
        recordKind: "fact",
        scope: namespace.kind,
        ...(namespace.kind === "bot" ? { botId: namespace.botId } : {}),
      },
    });
    if (result.status === "duplicate")
      throw new BridgeFailure("revision_conflict", "Duplicate appeared during import; run a fresh preview");
    return result.memoryRef;
  }
}

function staleReplay(): BridgeFailure {
  return new BridgeFailure(
    "context_invalidated",
    "Imported memories or sources changed; run a fresh preview",
  );
}

function mapError(error: unknown): unknown {
  if (!(error instanceof MutationError)) return error;
  switch (error.code) {
    case "scope_denied":
    case "context_invalidated":
    case "request_conflict":
      return new BridgeFailure(error.code, error.message);
    default:
      return error;
  }
}

function buildPlan(store: MemoryStore, db: Database, paths: string[], namespace: MemoryNamespace): Plan {
  const scan: Scan = {
    db,
    store,
    namespace,
    plan: { files: [], candidates: [], unsupported: [] },
    keys: new Set(),
  };
  const canonicalSeen = new Set<string>();
  for (const path of paths) {
    const source = readSource(path);
    if ("reason" in source) {
      scan.plan.unsupported.push({ path, reason: source.reason });
      continue;
    }
    if (canonicalSeen.has(source.canonicalPath)) {
      scan.plan.unsupported.push({ path, reason: "duplicate canonical path" });
      continue;
    }
    canonicalSeen.add(source.canonicalPath);
    const decoded = decodeText(source.raw);
    if ("reason" in decoded) {
      scan.plan.unsupported.push({ path, reason: decoded.reason });
      continue;
    }
    const file: FileRecord = {
      path,
      canonicalPath: source.canonicalPath,
      sourceHash: createHash("sha256").update(source.raw).digest("hex"),
      bytes: source.raw.byteLength,
    };
    scan.plan.files.push(file);
    collectFacts(scan, file, decoded.text);
  }
  return scan.plan;
}

function readSource(path: string): SourceRead {
  if (!isAbsolute(path)) return { reason: "path must be absolute" };
  if (extname(path).toLowerCase() !== ".md") return { reason: "not a Markdown (.md) file" };
  try {
    if (lstatSync(path).isSymbolicLink()) return { reason: "symlink files are not imported" };
    const canonicalPath = realpathSync(path);
    const before = lstatSync(canonicalPath);
    if (!before.isFile()) return { reason: "not a regular file" };
    if (before.size > MAX_FILE_BYTES) return { reason: "file exceeds 64 KiB" };
    const raw = readBounded(canonicalPath, before);
    if (raw === null) return { reason: "file changed or exceeded 64 KiB while reading" };
    return { raw, canonicalPath };
  } catch {
    return { reason: "unreadable" };
  }
}

// O_NOFOLLOW refuses a symlink swapped in after lstat; identity and size must hold before and after the read.
function readBounded(path: string, before: Stats): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(fstatSync(fd), before)) return null;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    let read = readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      length += read;
      if (length > MAX_FILE_BYTES) return null;
      read = readSync(fd, buffer, length, buffer.length - length, null);
    }
    const after = fstatSync(fd);
    if (!sameFile(after, before) || after.size !== length) return null;
    if (!sameFile(lstatSync(path), before)) return null;
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function decodeText(raw: Buffer): Decoded {
  if (raw.includes(0)) return { reason: "binary content" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
  } catch {
    return { reason: "invalid UTF-8" };
  }
}

function collectFacts(scan: Scan, file: FileRecord, text: string): void {
  const extracted = extract(text);
  for (const reason of extracted.fences) scan.plan.unsupported.push({ path: file.path, reason });
  for (const [ordinal, block] of extracted.blocks.entries()) admit(scan, file, block, ordinal);
}

// Ordinals count every extracted block, so source IDs depend only on file content.
function admit(scan: Scan, file: FileRecord, block: Block, ordinal: number): void {
  const { plan, keys } = scan;
  const skip = (reason: string): void => {
    plan.unsupported.push({ path: file.path, reason });
  };
  if (block.text.length > MAX_FACT_CHARS) {
    skip(`oversized fact at line ${block.line}`);
    return;
  }
  if (redact(block.text) !== block.text) {
    skip(`sensitive content at line ${block.line}; not persisted`);
    return;
  }
  const title = titleOf(block.text);
  const key = sha256(`note\n${title}\n${block.text}`);
  if (keys.has(key)) {
    skip(`duplicate of an earlier fact in preview at line ${block.line}`);
    return;
  }
  if (plan.candidates.length >= MAX_CANDIDATES) {
    skip("candidate cap reached");
    return;
  }
  const sourceId = `artifact:bridge-import-${sha256(
    [namespaceKey(scan.namespace), file.canonicalPath, file.sourceHash, String(ordinal)].join("\n"),
  )}`;
  if (scan.store.provenance.sourceTombstoned(sourceId)) {
    skip("forgotten source");
    return;
  }
  keys.add(key);
  plan.candidates.push({
    sourceId,
    sourcePath: file.path,
    sourceHash: file.sourceHash,
    title,
    content: block.text,
    duplicate: findDuplicate(scan.db, scan.namespace, key),
  });
}

function titleOf(content: string): string {
  return content.length > TITLE_CHARS ? `${content.slice(0, TITLE_CHARS)}...` : content;
}

// Same content_hash formula as mutations.ts: sha256(type\ntitle\ncontent).
function findDuplicate(db: Database, namespace: MemoryNamespace, contentHash: string): MemoryRef | null {
  const where = namespaceColumns(namespace);
  const row = db
    .query<{ id: number; record_revision: number }, [string, string, string, string]>(
      "SELECT id,record_revision FROM memories WHERE content_hash=? AND scope=? AND ifnull(project_key,'')=? AND ifnull(bot_id,'')=? AND deleted_at IS NULL ORDER BY id LIMIT 1",
    )
    .get(contentHash, where.scope, where.project_key ?? "", where.bot_id ?? "");
  return row ? { id: row.id, revision: row.record_revision } : null;
}

interface ExtractState {
  blocks: Block[];
  fences: string[];
  open: Block | null;
  fence: number | null;
}

function extract(text: string): Extracted {
  const state: ExtractState = { blocks: [], fences: [], open: null, fence: null };
  for (const [index, line] of text.split("\n").entries()) scanLine(state, line, index + 1);
  state.open = flush(state.blocks, state.open);
  if (state.fence !== null) state.fences.push(`unclosed code fence at line ${state.fence}`);
  return { blocks: state.blocks, fences: state.fences };
}

function scanLine(state: ExtractState, line: string, number: number): void {
  if (state.fence !== null) {
    if (FENCE.test(line)) {
      state.fences.push(`code fence at line ${state.fence}`);
      state.fence = null;
    }
    return;
  }
  if (FENCE.test(line)) {
    state.open = flush(state.blocks, state.open);
    state.fence = number;
    return;
  }
  if (BLANK.test(line) || HEADING.test(line)) {
    state.open = flush(state.blocks, state.open);
    return;
  }
  const item = BULLET.exec(line);
  if (item) {
    state.open = flush(state.blocks, state.open);
    state.open = { line: number, text: item[1] ?? "" };
    return;
  }
  state.open = state.open
    ? { line: state.open.line, text: `${state.open.text} ${line.trim()}` }
    : { line: number, text: line.trim() };
}

function flush(blocks: Block[], open: Block | null): null {
  if (open) blocks.push({ line: open.line, text: open.text.replace(/\s+/g, " ").trim() });
  return null;
}

function planDigest(namespace: MemoryNamespace, plan: Plan): string {
  return sha256(
    canonicalBody({
      namespace,
      files: plan.files,
      unsupported: plan.unsupported,
      candidates: plan.candidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        sourcePath: candidate.sourcePath,
        sourceHash: candidate.sourceHash,
        contentHash: sha256(candidate.content),
        duplicate: candidate.duplicate,
      })),
    }),
  );
}

function hmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

function verifyToken(token: string, secret: string): TokenPayload {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) throw unauthorized();
  const body = token.slice(0, cut);
  const expected = Buffer.from(hmac(secret, body));
  const actual = Buffer.from(token.slice(cut + 1));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unauthorized();
  const parsed = TokenPayloadSchema.safeParse(decodePayload(body));
  if (!parsed.success) throw unauthorized();
  return parsed.data;
}

function decodePayload(body: string): unknown {
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function unauthorized(): BridgeFailure {
  return new BridgeFailure("unauthorized", "Preview token is invalid");
}
