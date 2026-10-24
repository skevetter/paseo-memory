import type { Database } from "bun:sqlite";
import type { Evidence, LifecycleDetail, MemoryRef } from "../shared/lifecycle";
import { type Logger, silentLogger } from "../shared/log";
import type { ResourceStatus } from "../shared/resources";
import { RETRIEVAL_ABSOLUTE_LIMITS, type RecordKind, type RerankMode } from "../shared/retrieval";
import {
  DEFAULT_RUNTIME,
  MAX_CONTENT_CHARS,
  type MemoryDetail,
  type ProjectRef,
  type RuntimeConfig,
  type SearchScope,
  type ServiceParsedInput,
} from "../shared/service-api";
import {
  Access,
  type MergeRequest,
  type MergeResult,
  type MutationOutcome,
  type Namespace,
  type Scope,
  type SqlFilter,
} from "./access";
import { AuditLog } from "./audit";
import type { Embedder, EmbedKind, TierSpec } from "./embedder";
import { MemoryFeedback, retractFeedbackEvidence } from "./feedback";
import { type IndexHealth, IndexRetry, type IndexRetryOptions } from "./index-retry";
import {
  InferenceMetrics,
  InferenceQueue,
  InferenceQueueError,
  type InferenceQueueOptions,
} from "./inference-queue";
import { currentLifecycleSql, Lifecycle } from "./lifecycle";
import { pruneRetiredIndexes, selectIndexTarget } from "./model-indexes";
import { modelIdentityFingerprint } from "./model-manifest";
import { canonicalBody, MemoryMutations, MutationError, ownerMutation } from "./mutations";
import { Provenance } from "./provenance";
import { redact } from "./redact";
import { RERANK_CANDIDATES, type Reranker } from "./reranker";
import { ResourceUsageLedger } from "./resource-usage";
import { resourceSnapshot } from "./resources";
import { RetrievalCache } from "./retrieval-cache";
import { RetrievalPolicies } from "./retrieval-policy";
import { type ClosedReview, type Reservation, ReviewLedger } from "./review-ledger";
import { formatSave } from "./save-receipt";
import { migrate } from "./schema";
import {
  currentSessionHits,
  listSessions,
  recordTurn,
  type SessionHit,
  type SessionReview,
  type SessionRow,
  searchSessions,
  sessionVersion,
  storeReview,
  type TurnInput,
} from "./sessions";
import { errorText, openDatabase } from "./sqlite";
import { clip, ftsQuery, RRF_K, sha256 } from "./text";
import {
  dropVectors,
  type Neighbor,
  STALE_VECTOR_SQL,
  scopeKey,
  VectorIndex,
  type VectorTarget,
  vecTables,
} from "./vectors";

export type { IndexHealth, ProjectRef, Scope, SearchScope, SessionRow };
export { clip, ftsQuery, scopeKey };

const PINNED_BOOST = 0.1;
const PROJECT_BOOST = 0.05;
const MAX_RECENCY_BOOST = 0.06;
const RECENCY_HALF_LIFE_DAYS = 30;
const MAX_USAGE_BOOST = 0.04;
const FULL_USAGE_BOOST_USES = 31;
const MAX_OPEN_BOOST = 0.06;
const NEVER_OPENED_AFTER_SHOWN = 10;
const NEVER_OPENED_FACTOR = 0.95;

export function usageFactor(counts: { shown: number; opened: number }): number {
  if (counts.shown >= NEVER_OPENED_AFTER_SHOWN && counts.opened === 0) return NEVER_OPENED_FACTOR;
  return 1 + MAX_OPEN_BOOST * Math.min(1, counts.opened / Math.max(1, counts.shown));
}

export class ContentTooLongError extends Error {
  constructor(length: number) {
    super(
      `Content is ${length} characters and the limit is ${MAX_CONTENT_CHARS}. Save one durable fact in ` +
        "under 800 characters, or split it into separate memories.",
    );
  }
}

export interface MemoryRow {
  id: number;
  scope: Scope;
  project_key: string | null;
  type: string;
  title: string;
  content: string;
  topic_key: string | null;
  content_hash: string;
  pinned: number;
  revision_count: number;
  duplicate_count: number;
  source: string;
  agent_id: string | null;
  provider: string | null;
  workspace_dir: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  use_count: number;
  last_used_at: string | null;
  shown_count: number;
  opened_count: number;
  last_retrieved_at: string | null;
  application_count: number;
  validated_helpful_count: number;
  validated_harmful_count: number;
  kept_at: string | null;
  archived_at: string | null;
  merged_into: number | null;
  deleted_at: string | null;
  index_generation: number;
  record_revision: number;
  record_kind: "fact" | "preference" | "episode" | "derived_summary" | "lesson" | "procedure_ref";
  state: "candidate" | "active" | "rejected" | "superseded" | "needs_recheck" | "archived";
  verification_status: "unverified" | "verified" | "unresolved";
  valid_from: string | null;
  valid_until: string | null;
  verified_at: string | null;
}

export type MemoryWithProject = MemoryRow & { project_name: string | null };

export interface SaveInput {
  title: string;
  content: string;
  type: string;
  scope: Scope;
  project: ProjectRef | null;
  topicKey?: string | null;
  pinned?: boolean;
  force?: boolean;
  source?: string;
  agentId?: string | null;
  provider?: string | null;
  workspaceDir?: string | null;
}

export type SaveResult =
  | { status: "created" | "updated" | "duplicate"; id: number }
  | { status: "near_duplicate"; id: number; title: string; similarity: number }
  | {
      status: "possible_duplicate";
      id: null;
      candidates: { id: number; title: string; similarity: number }[];
    };

export interface MemoryHit {
  kind: "memory";
  id: string;
  revision: number;
  title: string;
  type: string;
  scope: Scope;
  projectKey: string | null;
  projectName: string | null;
  preview: string;
  pinned: boolean;
  updatedAt: string;
  useCount: number;
  shownCount: number;
  openedCount: number;
  lastUsedAt: string | null;
  topicKey: string | null;
  score: number;
  similarity: number | null;
  relevance: number | null;
}

export type SearchHit = MemoryHit | SessionHit;

export interface SearchInput {
  query: string;
  access: Access;
  scope?: SearchScope;
  type?: string;
  limit?: number;
  includeSessions?: boolean;
  track?: boolean;
  /** Late results are dropped once this aborts; backends that cannot cancel finish on their own. */
  signal?: AbortSignal;
  mode?: "hybrid" | "lexical";
  maxCandidates?: number;
  rerankMode?: RerankMode;
  recordKinds?: RecordKind[];
  policyRevision?: number;
  onFallback?: (reason: string) => void;
}

type ResolvedSearchInput = SearchInput & { scope: SearchScope; limit: number; maxCandidates: number };

export interface ListInput {
  access: Access;
  scope?: SearchScope;
  type?: string;
  limit?: number;
  pinned?: boolean;
  stale?: boolean;
  recordKinds?: RecordKind[];
}

export interface CandidateRead {
  memory: MemoryRow;
  evidence: Evidence[];
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  type?: string;
  pinned?: boolean;
  topicKey?: string | null;
  scope?: Scope;
  project?: ProjectRef | null;
}

interface Candidate {
  hit: SearchHit;
  text: string;
  weight: number;
}

// No source text is retained between searches. Every cache read resolves these refs through current SQL grants.
interface CandidateRef {
  id: number;
  revision: number;
  rank: number;
  similarity: number | null;
}

interface CachedCandidates {
  refs: CandidateRef[];
  nextValidityAt: number;
}

interface QueryVectorResult {
  vector: Float32Array | null;
  failure: string | null;
}
interface QueryFlight {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  work: Promise<QueryVectorResult>;
}

export interface StoreOptions {
  path: string;
  sqlitePath?: string | null;
  now?: () => Date;
  log?: Logger;
  indexRetry?: IndexRetryOptions;
  inference?: InferenceQueueOptions;
}

interface SaveDraft {
  input: SaveInput;
  title: string;
  content: string;
  scope: Scope;
  projectKey: string | null;
  hash: string;
  topicKey: string | null;
  vector: Float32Array | null;
}

type IndexRow = Pick<
  MemoryRow,
  "id" | "title" | "content" | "scope" | "project_key" | "content_hash" | "index_generation"
>;
type RemovedRow = Pick<MemoryRow, "scope" | "project_key" | "merged_into" | "archived_at">;
interface MergeRevisions {
  sourceRevision: number;
  targetRevision: number;
}

const HIDDEN_DETAIL: MemoryDetail = {
  memory: null,
  mergedInto: null,
  mergeId: null,
  mergeRevisions: null,
  archived: false,
  versions: [],
  duplicates: [],
};

const MAX_SEARCH_CANDIDATES = RETRIEVAL_ABSOLUTE_LIMITS.maxCandidates;
const EXACT_MATCH_LIMIT = 5;
const INDEX_BATCH = 16;

export class MemoryStore {
  readonly path: string;
  readonly sqliteLibrary: string | null;
  readonly sqliteVersion: string;
  readonly sqliteVecVersion: string;
  readonly audit: AuditLog;
  readonly reviews: ReviewLedger;
  readonly provenance: Provenance;
  readonly lifecycle: Lifecycle;
  readonly mutations: MemoryMutations;
  readonly retrievalPolicies: RetrievalPolicies;
  readonly inference: InferenceQueue;
  readonly usage: ResourceUsageLedger;
  readonly feedback: MemoryFeedback;
  readonly retrievalMetrics = new InferenceMetrics();
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly log: Logger;
  private embedder: Embedder | null = null;
  private vectors: VectorIndex | null = null;
  private reranker: Reranker | null = null;
  private rerankerFingerprint: string | null = null;
  private indexing: Promise<void> | null = null;
  private indexAgain = false;
  private readonly retry: IndexRetry;
  private closed = false;
  private embeddingEpoch = 0;
  private queryEpoch = 0;
  private inferenceEpoch = 0;
  private readonly queryVectors: RetrievalCache<Float32Array>;
  private readonly candidateIds: RetrievalCache<CachedCandidates>;
  private readonly queryFlights = new Map<string, QueryFlight>();
  private dataVersion = 0;
  config: RuntimeConfig = DEFAULT_RUNTIME;

  constructor(options: StoreOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? silentLogger;
    this.retry = new IndexRetry(options.indexRetry);
    this.inference = new InferenceQueue(options.inference);
    const opened = openDatabase(options.path, options.sqlitePath ?? null);
    this.db = opened.db;
    this.sqliteLibrary = opened.sqliteLibrary;
    this.sqliteVersion = opened.sqliteVersion;
    this.sqliteVecVersion = opened.sqliteVecVersion;
    migrate(this.db);
    selectIndexTarget(this.db, null);
    this.retrievalPolicies = new RetrievalPolicies(this.db);
    this.config = this.retrievalPolicies.runtime;
    this.queryVectors = new RetrievalCache(128, 300_000, () => this.now().getTime());
    this.candidateIds = new RetrievalCache(128, 30_000, () => this.now().getTime());
    this.db.query("INSERT OR IGNORE INTO meta (key,value) VALUES ('retrieval_generation','0')").run();
    this.dataVersion = this.readDataVersion();
    this.usage = new ResourceUsageLedger(this.db, () => this.ts());
    this.audit = new AuditLog(
      this.db,
      () => this.ts(),
      (result) => this.usage.prepared(result),
    );
    this.reviews = new ReviewLedger(this.db, this.now);
    this.provenance = new Provenance(this.db, () => this.ts());
    this.lifecycle = new Lifecycle(this.db, () => this.ts());
    this.feedback = new MemoryFeedback(this.db, {
      provenance: this.provenance,
      lifecycle: this.lifecycle,
      now: () => this.ts(),
      changed: () => this.advanceRetrieval(),
    });
    this.mutations = new MemoryMutations(this.db, {
      provenance: this.provenance,
      lifecycle: this.lifecycle,
      reviews: this.reviews,
      cancelReviews: (agentIds) => this.cancelReviewWindows(agentIds),
      now: () => this.ts(),
      changed: (operation) => {
        if (operation === "forget") this.clearQueryCache();
        this.advanceRetrieval();
        this.scheduleIndex();
      },
    });
    this.lifecycle.resume();
  }

  close(): void {
    this.closed = true;
    this.inference.close();
    this.clearQueryCache();
    this.candidateIds.clear();
    this.lifecycle.close();
    this.db.close();
  }

  get activeSpec(): TierSpec | null {
    return this.embedder?.spec ?? null;
  }
  get retrievalGeneration(): number {
    this.refreshExternalWrites();
    return Number(this.getMeta("retrieval_generation") ?? "0");
  }
  resourceStatus(): ResourceStatus {
    this.feedback.expire();
    return resourceSnapshot(this.db, {
      at: this.ts(),
      servingFingerprint: this.vectors?.fingerprint ?? null,
      rerankerFingerprint: this.rerankerFingerprint,
      inference: this.inference.snapshot(),
      retrieval: this.retrievalMetrics.snapshot(),
      usage: this.usage.summary(),
      currentFeedbackHints: this.feedback.currentHintTotals(),
    });
  }
  admitContext(input: ServiceParsedInput<"context-admit">): { admitted: true } {
    const current = this.db
      .transaction(() => {
        const issued = this.audit.issuedContext(input);
        if (!issued || this.lifecycle.contextInvalidated({ nonce: input.nonce }))
          throw new MutationError("context_invalidated", "The issued context is unavailable or revoked.");
        const access = Access.agent(issued.projectKey);
        const memories = new Map(
          this.getVisible(
            access,
            issued.selection.memoryRefs.map((ref) => ref.id),
          ).map((row) => [row.id, row.record_revision]),
        );
        return {
          issued,
          memories,
          evidenceCount: this.provenance.getVisible(access, issued.selection.evidenceRefs).length,
          sessions: new Map(
            this.visibleSessions(access, issued.injection.sessions).map((row) => [
              row.id,
              sessionVersion(row),
            ]),
          ),
          policyRevision: Number(this.getMeta("retrieval_policy_revision")),
          indexGeneration: this.retrievalGeneration,
        };
      })
      .immediate();
    const { injection, selection } = current.issued;
    const snapshot = injection.admission;
    if (
      snapshot.policyRevision !== current.policyRevision ||
      snapshot.indexGeneration !== current.indexGeneration
    )
      throw new MutationError("context_invalidated", "The context policy or source generation changed.");
    if (selection.memoryRefs.some((ref) => current.memories.get(ref.id) !== ref.revision))
      throw new MutationError("context_invalidated", "A selected memory is no longer current or authorized.");
    if (current.evidenceCount !== selection.evidenceRefs.length)
      throw new MutationError("context_invalidated", "Selected evidence is no longer authorized.");
    if (snapshot.sessionVersions.some((ref) => current.sessions.get(ref.id) !== ref.version))
      throw new MutationError(
        "context_invalidated",
        "A selected session is no longer current or authorized.",
      );
    return { admitted: true };
  }
  openReviewWindow(input: Parameters<ReviewLedger["open"]>[0]): void {
    this.db
      .transaction(() => {
        if (this.sessionInvalidated(input.agentId))
          throw new MutationError("context_invalidated", "The review context was invalidated.");
        const windowId = this.reviews.open(input);
        const attemptId = this.reviewAttemptId(input.agentId, windowId);
        this.usage.record("paseo_host", {
          eventId: `requested:${attemptId}`,
          attemptId,
          sourceSequence: 0,
          stage: "review",
          status: "requested",
          provenance: "unavailable",
        });
      })
      .immediate();
  }

  closeReviewWindow(end: ServiceParsedInput<"review-end">): ClosedReview | null {
    return this.db
      .transaction(() => {
        const closed = this.reviews.close(end.agentId);
        if (!closed) return null;
        const attemptId = this.reviewAttemptId(end.agentId, closed.windowId);
        const sourceEventId = end.turnId
          ? `native-turn:${sha256(canonicalBody([end.agentId, end.turnId]))}`
          : null;
        this.usage.record("paseo_host", {
          eventId: `ended:${attemptId}`,
          attemptId,
          sourceSequence: 1,
          stage: "review",
          status: end.outcome,
          provenance: "unavailable",
          sourceEventId,
          durationMs: closed.durationMs,
        });
        return closed;
      })
      .immediate();
  }

  private cancelReviewWindows(agentIds: string[]): void {
    for (const agentId of agentIds) {
      const windows = this.db
        .query<{ window_id: string }, [string]>(
          "SELECT window_id FROM review_windows WHERE agent_id=? AND closed_at IS NULL",
        )
        .all(agentId);
      for (const window of windows) {
        const attemptId = this.reviewAttemptId(agentId, window.window_id);
        this.usage.record("paseo_host", {
          eventId: `cancelled:${attemptId}`,
          attemptId,
          sourceSequence: 1,
          stage: "review",
          status: "cancelled",
          provenance: "unavailable",
        });
      }
    }
  }

  private reviewAttemptId(agentId: string, windowId: string): string {
    return `review:${sha256(canonicalBody([agentId, windowId]))}`;
  }

  private readDataVersion(): number {
    return this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
  }

  private refreshExternalWrites(): void {
    const version = this.readDataVersion();
    if (version === this.dataVersion) return;
    this.dataVersion = version;
    this.advanceRetrieval();
  }

  private advanceRetrieval(): void {
    this.db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='retrieval_generation'").run();
    this.candidateIds.clear();
  }

  private clearQueryCache(): void {
    this.queryEpoch += 1;
    this.inferenceEpoch += 1;
    for (const flight of this.queryFlights.values()) flight.controller.abort();
    this.inference.cancelPending("inference_epoch_changed");
    this.queryVectors.clear();
    this.queryFlights.clear();
  }

  get inferenceRevision(): number {
    return this.inferenceEpoch;
  }

  private queryFingerprint(): string {
    return this.vectors?.fingerprint ?? "lexical";
  }

  private queryVector(query: string, signal?: AbortSignal): Promise<QueryVectorResult> {
    if (signal?.aborted) return Promise.resolve({ vector: null, failure: "inference_cancelled" });
    const embedder = this.embedder;
    const epoch = this.embeddingEpoch;
    const queryEpoch = this.queryEpoch;
    if (!embedder) return Promise.resolve({ vector: null, failure: "embedding_unavailable" });
    const key = JSON.stringify([this.queryFingerprint(), sha256(query)]);
    const cached = this.queryVectors.get(key);
    if (cached) return Promise.resolve({ vector: cached, failure: null });
    const pending = this.queryFlights.get(key);
    if (pending && !pending.controller.signal.aborted) return waitForQuery(pending, signal);
    const flight: QueryFlight = {
      controller: new AbortController(),
      consumers: 0,
      settled: false,
      work: Promise.resolve({ vector: null, failure: null }),
    };
    let failure: string | null = null;
    flight.work = this.embedOne(query, "query", {
      signal: flight.controller.signal,
      failed: (reason) => {
        failure = reason;
      },
    })
      .then((vector) => {
        if (
          vector &&
          this.embeddingEpoch === epoch &&
          this.queryEpoch === queryEpoch &&
          this.embedder === embedder &&
          !this.closed
        )
          this.queryVectors.set(key, vector);
        return { vector, failure };
      })
      .finally(() => {
        flight.settled = true;
        if (this.queryFlights.get(key) === flight) this.queryFlights.delete(key);
      });
    if (this.queryFlights.size < 128) this.queryFlights.set(key, flight);
    return waitForQuery(flight, signal);
  }

  setEmbedder(embedder: Embedder | null): void {
    if (this.closed) return;
    const vectors = embedder ? new VectorIndex(this.db, embedder.spec, () => this.ts()) : null;
    this.clearQueryCache();
    this.embeddingEpoch += 1;
    this.advanceRetrieval();
    this.embedder = embedder;
    this.vectors = vectors;
    this.retry.clear();
    if (!embedder) {
      selectIndexTarget(this.db, null);
      return;
    }
    this.setMeta("embedding_model", embedder.spec.model);
    this.setMeta("embedding_dims", String(embedder.spec.dims));
    this.scheduleIndex();
  }

  setReranker(reranker: Reranker | null): void {
    if (this.closed || this.reranker === reranker) return;
    const fingerprint = reranker ? modelIdentityFingerprint(reranker.identity) : null;
    this.inferenceEpoch += 1;
    this.rerankerFingerprint = fingerprint;
    this.inference.cancelPending("inference_epoch_changed");
    this.reranker = reranker;
  }

  configure(config: RuntimeConfig): void {
    const previous = this.retrievalPolicies.revision;
    this.retrievalPolicies.configure(config);
    this.config = this.retrievalPolicies.runtime;
    if (previous !== this.retrievalPolicies.revision) {
      this.candidateIds.clear();
      this.inference.cancelPending("policy_changed");
      this.scheduleIndex();
    }
  }

  upsertProject(project: ProjectRef): void {
    const ts = this.ts();
    this.db
      .query(
        `INSERT INTO projects (key, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name,
           root_path = coalesce(excluded.root_path, projects.root_path), updated_at = excluded.updated_at`,
      )
      .run(project.key, project.name, project.rootPath, ts, ts);
    if (!project.paseoProjectId) return;
    this.db
      .query(
        `INSERT INTO project_aliases (paseo_project_id, project_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(paseo_project_id) DO UPDATE SET project_key = excluded.project_key, updated_at = excluded.updated_at`,
      )
      .run(project.paseoProjectId, project.key, ts);
  }

  projectByPaseoId(paseoProjectId: string): ProjectRef | null {
    const row = this.db
      .query<{ key: string; name: string; root_path: string | null }, [string]>(
        `SELECT p.key, p.name, p.root_path FROM project_aliases a JOIN projects p ON p.key = a.project_key
         WHERE a.paseo_project_id = ?`,
      )
      .get(paseoProjectId);
    return row ? { key: row.key, name: row.name, rootPath: row.root_path, paseoProjectId } : null;
  }

  projectByKey(key: string): ProjectRef | null {
    const row = this.db
      .query<{ name: string; root_path: string | null }, [string]>(
        `SELECT name, root_path FROM projects WHERE key = ?`,
      )
      .get(key);
    return row ? { key, name: row.name, rootPath: row.root_path, paseoProjectId: null } : null;
  }

  async save(input: SaveInput, reservation?: Reservation): Promise<SaveResult> {
    if (input.content.length > MAX_CONTENT_CHARS) {
      reservation && this.reviews.release(reservation);
      throw new ContentTooLongError(input.content.length);
    }
    const title = redact(input.title).trim().slice(0, 200);
    const content = redact(input.content).trim();
    if (!title || !content) throw new Error("title and content are required");
    const vector = await this.embedOne(`${title}\n${content}`, "document");
    const scope: Scope = input.scope === "project" && input.project ? "project" : "global";
    const draft: SaveDraft = {
      input,
      title,
      content,
      scope,
      projectKey: scope === "project" ? (input.project?.key ?? null) : null,
      hash: sha256(`${input.type}\n${title}\n${content}`),
      topicKey: input.topicKey?.trim() || null,
      vector,
    };
    // Everything below is synchronous, so no other request interleaves with the checks.
    return this.settled(
      reservation,
      () => this.saveNow(draft),
      (result) => ({
        consumed: result.status === "created" || result.status === "updated",
        memoryId: result.id,
        receipt: formatSave(result, scope === "project" ? input.project : null),
      }),
    );
  }

  getVisible(
    access: Access,
    ids: number[],
    selection?: Pick<SearchInput, "scope" | "type" | "recordKinds">,
  ): MemoryWithProject[] {
    if (ids.length === 0) return [];
    this.feedback.expire();
    const filter = access.memoryFilter(
      selection?.scope ?? "all",
      selection?.type,
      this.ts(),
      selection?.recordKinds,
    );
    const rows = this.db
      .prepare<MemoryWithProject, (string | number)[]>(`SELECT m.*,p.name AS project_name FROM memories m
      LEFT JOIN projects p ON p.key=m.project_key WHERE ${filter.where} AND m.id IN (${ids.map(() => "?").join(",")})`)
      .all(...filter.params, ...ids);
    this.feedback.projectCurrentHints(rows);
    return rows;
  }

  readCandidate(access: Access, actorId: string, id: number): CandidateRead | null {
    const metadata = this.db
      .query<
        Pick<MemoryRow, "id" | "scope" | "project_key" | "record_revision">,
        [number, string]
      >(`SELECT m.id,m.scope,m.project_key,m.record_revision
      FROM memories m JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=1
      WHERE m.id=? AND m.state='candidate' AND m.deleted_at IS NULL AND r.actor_id=?`)
      .get(id, actorId);
    if (!metadata || !access.allows("read", { scope: metadata.scope, projectKey: metadata.project_key }))
      return null;
    const memory = this.rowsById([id])[0];
    if (
      memory?.state !== "candidate" ||
      memory.record_revision !== metadata.record_revision ||
      !access.allows("read", namespaceOf(memory))
    )
      return null;
    return { memory, evidence: this.visibleEvidence(access, { id, revision: memory.record_revision }) };
  }

  currentEvidence(access: Access, ref: MemoryRef): Evidence[] {
    const row = this.getVisible(access, [ref.id])[0];
    if (!row || row.record_revision !== ref.revision) return [];
    return this.visibleEvidence(access, ref);
  }

  private visibleEvidence(access: Access, ref: MemoryRef): Evidence[] {
    const ids = this.db
      .query<{ evidence_id: string }, [number, number]>(
        "SELECT evidence_id FROM memory_evidence_links WHERE memory_id=? AND revision=? ORDER BY evidence_id",
      )
      .all(ref.id, ref.revision)
      .map((link) => link.evidence_id);
    return this.provenance.getVisible(access, ids);
  }

  /** Ids that exist but are outside the caller's grant; callers report them as missing and audit the denial. */
  deniedIds(access: Access, ids: number[]): number[] {
    return this.rowsById(ids)
      .filter((row) => !access.allows("read", namespaceOf(row)))
      .map((row) => row.id);
  }

  private rowsById(ids: number[]): MemoryWithProject[] {
    if (ids.length === 0) return [];
    return this.db
      .prepare<MemoryWithProject, number[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE m.id IN (${ids.map(() => "?").join(",")}) AND m.deleted_at IS NULL`,
      )
      .all(...ids);
  }

  markShown(ids: number[]): void {
    this.bump(ids, "shown_count = shown_count + 1, last_retrieved_at = ?", [this.ts()]);
  }

  markOpened(ids: number[]): void {
    this.bump(ids, "opened_count = opened_count + 1, last_retrieved_at = ?", [this.ts()]);
  }

  keep(access: Access, id: number): MutationOutcome {
    const existing = this.rowsById([id])[0];
    if (!existing) return "not_found";
    if (!access.allows("write", namespaceOf(existing))) return "denied";
    this.db.query(`UPDATE memories SET kept_at = ? WHERE id = ?`).run(this.ts(), id);
    return "ok";
  }

  archive(access: Access, id: number): MutationOutcome {
    const existing = this.rowsById([id])[0];
    if (!existing) return "not_found";
    if (!access.allows("delete", namespaceOf(existing))) return "denied";
    const ts = this.ts();
    this.db
      .query(
        `UPDATE memories SET state='archived',deleted_at=?,archived_at=?,updated_at=?,record_revision=record_revision+1,index_generation=index_generation+1 WHERE id=?`,
      )
      .run(ts, ts, ts, id);
    this.lifecycle.invalidate({ id, revision: existing.record_revision });
    dropVectors(this.db, id);
    this.advanceRetrieval();
    return "ok";
  }

  /** The merge target of a removed memory, only when the caller may read both ends of the merge. */
  mergedIntoVisible(access: Access, id: number): number | null {
    const removed = this.removed(id);
    return removed ? this.visibleMergeTarget(access, removed) : null;
  }

  private visibleMergeTarget(access: Access, removed: RemovedRow): number | null {
    if (removed.merged_into === null || !access.allows("read", namespaceOf(removed))) return null;
    const target = this.removed(removed.merged_into);
    return target && access.allows("read", namespaceOf(target)) ? removed.merged_into : null;
  }

  updateAuthorized(
    access: Access,
    id: number,
    patch: MemoryPatch,
    reservation?: Reservation,
  ): MutationOutcome {
    return this.settled(
      reservation,
      () => {
        const existing = this.rowsById([id])[0];
        if (!existing) return "not_found";
        if (!access.allows("write", namespaceOf(existing))) return "denied";
        const next = patched(existing, patch);
        if (!access.allows("write", { scope: next.scope, projectKey: next.projectKey })) return "denied";
        return this.applyUpdate(existing, patch) ? "ok" : "unchanged";
      },
      (outcome) => ({
        consumed: outcome === "ok",
        memoryId: id,
        receipt:
          outcome === "unchanged"
            ? `unchanged: #${id} already says this`
            : outcome === "ok"
              ? `updated: #${id}`
              : `not found: #${id}`,
      }),
    );
  }

  // Returns false when the patch changes nothing, so callers do not count a revision or a review slot for it.
  private applyUpdate(existing: MemoryRow, patch: MemoryPatch): boolean {
    if (patch.content !== undefined && patch.content.length > MAX_CONTENT_CHARS) {
      throw new ContentTooLongError(patch.content.length);
    }
    const next = patched(existing, patch);
    const { textChanged, reindex, changed } = classifyChange(existing, next);
    if (!changed) return false;
    this.lifecycle.invalidate({ id: existing.id, revision: existing.record_revision });
    if (next.project) this.upsertProject(next.project);
    this.db
      .query(
        `UPDATE memories SET title = ?, content = ?, type = ?, pinned = ?, topic_key = ?, content_hash = ?,
         scope = ?, project_key = ?, revision_count = revision_count + ?, record_revision = record_revision + 1,
         index_generation = index_generation + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.content,
        next.type,
        next.pinned,
        next.topicKey,
        next.hash,
        next.scope,
        next.projectKey,
        textChanged ? 1 : 0,
        reindex ? 1 : 0,
        this.ts(),
        existing.id,
      );
    this.advanceRetrieval();
    if (reindex) {
      dropVectors(this.db, existing.id);
      this.scheduleIndex();
    }
    return true;
  }

  private settled<T>(
    reservation: Reservation | undefined,
    run: () => T,
    outcome: (value: T) => { consumed: boolean; memoryId: number | null; receipt?: string },
  ): T {
    try {
      return this.db.transaction(() => {
        if (reservation) this.reviews.assertActive(reservation);
        const value = run();
        if (reservation) this.reviews.settle(reservation, outcome(value));
        return value;
      })();
    } catch (error) {
      if (reservation) this.reviews.release(reservation);
      throw error;
    }
  }

  deleteAuthorized(access: Access, id: number, hard = false, reservation?: Reservation): MutationOutcome {
    return this.settled(
      reservation,
      () => {
        const existing = this.rowsById([id])[0];
        if (!existing) return "not_found";
        if (!access.allows("delete", namespaceOf(existing))) return "denied";
        if (hard) this.db.query(`DELETE FROM memories WHERE id = ?`).run(id);
        else {
          this.db
            .query(
              `UPDATE memories SET state='archived',deleted_at=?,updated_at=?,record_revision=record_revision+1,index_generation=index_generation+1 WHERE id=?`,
            )
            .run(this.ts(), this.ts(), id);
          this.lifecycle.invalidate({ id, revision: existing.record_revision });
        }
        dropVectors(this.db, id);
        this.advanceRetrieval();
        return "ok";
      },
      (outcome) => ({
        consumed: outcome === "ok",
        memoryId: id,
        receipt: outcome === "ok" ? `deleted: #${id}` : `not found: #${id}`,
      }),
    );
  }

  restoreAuthorized(access: Access, id: number, version: number): MutationOutcome {
    const existing = this.rowsById([id])[0];
    if (!existing) return "not_found";
    if (!access.allows("restore", namespaceOf(existing))) return "denied";
    const old = this.db
      .query<{ title: string; content: string }, [number, number]>(
        `SELECT json_extract(snapshot,'$.title') AS title, json_extract(snapshot,'$.content') AS content FROM memory_revisions WHERE memory_id = ? AND revision = ?`,
      )
      .get(id, version);
    if (!old) return "not_found";
    return this.applyUpdate(existing, { title: old.title, content: old.content }) ? "ok" : "unchanged";
  }

  /**
   * Soft-deletes `sourceId` into `targetId`. Both revisions must still be the ones the caller looked at, and both
   * snapshots are recorded so the merge can be undone.
   */
  mergeAuthorized(access: Access, request: MergeRequest, actor: "owner" | "upkeep" = "owner"): MergeResult {
    try {
      this.mutations.mutate(
        { id: actor, actorId: actor, access },
        {
          requestId: `merge:${request.sourceId}@${request.sourceRevision}:${request.targetId}@${request.targetRevision}`,
          operation: "merge",
          id: request.sourceId,
          expectedRevision: request.sourceRevision,
          change: { target: { id: request.targetId, revision: request.targetRevision } },
        },
      );
      return {
        ok: true,
        mergeId: this.openMerge(request.sourceId)?.id,
        message: `Merged #${request.sourceId} into #${request.targetId}.`,
      };
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      return { ok: false, conflict: error.code === "revision_conflict", message: error.message };
    }
  }

  undoMergeAuthorized(
    access: Access,
    mergeId: number,
    expected?: MergeRevisions,
  ): { ok: boolean; message: string } {
    const merge = this.db
      .query<{ source_id: number; target_id: number }, [number]>(
        "SELECT source_id,target_id FROM memory_merges WHERE id=?",
      )
      .get(mergeId);
    if (!merge) return { ok: false, message: "That merge does not exist." };
    const revisions = expected ?? this.mergeRevisionsFor(merge.source_id, merge.target_id);
    if (!revisions) return { ok: false, message: "Both memories must exist." };
    try {
      this.mutations.mutate(ownerMutation(access), {
        requestId: `undo:${mergeId}:${revisions.sourceRevision}:${revisions.targetRevision}`,
        operation: "undo_merge",
        id: merge.source_id,
        expectedRevision: revisions.sourceRevision,
        change: { mergeId, target: { id: merge.target_id, revision: revisions.targetRevision } },
      });
      return { ok: true, message: `Restored #${merge.source_id}.` };
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      return { ok: false, message: error.message };
    }
  }

  private openMerge(sourceId: number): { id: number } | null {
    return this.db
      .query<{ id: number }, [number]>(
        `SELECT id FROM memory_merges WHERE source_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceId);
  }

  detailAuthorized(access: Access, id: number): MemoryDetail {
    const row = this.rowsById([id])[0];
    const removed = row ? null : this.removed(id);
    const current = row ?? removed;
    if (current && !access.allows("read", namespaceOf(current))) return HIDDEN_DETAIL;
    const lifecycle = this.lifecycleDetail(access, id);
    const versions = (lifecycle?.revisions ?? [])
      .filter((revision) => revision.revision !== lifecycle?.memoryRef.revision)
      .map((revision) => ({
        version: revision.revision,
        title: String(revision.snapshot.title ?? ""),
        content: String(revision.snapshot.content ?? ""),
        createdAt: revision.changedAt,
      }));
    const mergedInto = removed ? this.visibleMergeTarget(access, removed) : null;
    return {
      memory: row ? memoryDetail(row) : null,
      mergedInto,
      mergeId: mergedInto === null ? null : (this.openMerge(id)?.id ?? null),
      mergeRevisions: this.mergeRevisionsFor(id, mergedInto),
      archived: Boolean(removed?.archived_at),
      versions,
      duplicates: row ? this.similarTo(row, access) : [],
    };
  }

  private mergeRevisionsFor(id: number, targetId: number | null): MergeRevisions | null {
    if (targetId === null) return null;
    return this.db
      .query<
        MergeRevisions,
        [number, number]
      >(`SELECT a.record_revision AS sourceRevision,b.record_revision AS targetRevision
      FROM memories a JOIN memories b ON b.id=? WHERE a.id=?`)
      .get(targetId, id);
  }

  countPinned(access: Access, recordKinds?: RecordKind[]): number {
    const filter = access.memoryFilter("all", undefined, this.ts(), recordKinds);
    return (
      this.db
        .query<{ count: number }, (string | number)[]>(
          `SELECT count(*) AS count FROM memories m WHERE m.pinned=1 AND ${filter.where}`,
        )
        .get(...filter.params)?.count ?? 0
    );
  }

  list(input: ListInput): MemoryHit[] {
    this.feedback.expire();
    const filter = input.access.memoryFilter(input.scope ?? "all", input.type, this.ts(), input.recordKinds);
    const touched = "max(m.updated_at, ifnull(m.verified_at, ''), ifnull(m.kept_at, ''))";
    const cutoff = new Date(this.now().getTime() - this.config.staleDays * 86_400_000).toISOString();
    const where = [filter.where];
    if (input.pinned !== undefined) where.push(`m.pinned = ${input.pinned ? 1 : 0}`);
    if (input.stale) where.push(`m.pinned = 0 AND ${touched} < ?`);
    const order = input.stale ? `${touched} ASC, m.id ASC` : "m.pinned DESC, m.updated_at DESC, m.id ASC";
    const rows = this.db
      .query<MemoryWithProject, (string | number)[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      )
      .all(...filter.params, ...(input.stale ? [cutoff] : []), input.limit ?? 50);
    this.feedback.projectCurrentHints(rows);
    return rows.map((row) => memoryHit(row, { score: 0 }));
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    if (this.searchInvalidated(input) || !this.searchPolicyCurrent(input)) return [];
    this.feedback.expire();
    this.refreshExternalWrites();
    const scoped = resolvedSearch(input);
    if (!scoped) return [];
    if (!scoped.query) return this.list(scoped);
    const exact = this.exactCandidates(scoped);
    if (exact !== null)
      return this.finishSearch(
        exact.candidates.map((candidate) => candidate.hit),
        scoped,
        new Map(exact.refs.map((ref) => [ref.id, ref.revision])),
        new Map(exact.refs.map((ref) => [ref.id, ref.rank])),
      );
    const inferenceEpoch = this.inferenceEpoch;
    const refs = await this.searchRefs(scoped);
    if (refs === ABORTED) return [];
    if (refs === MODEL_CHANGED) return this.search({ ...scoped, mode: "lexical" });
    if (this.searchInvalidated(scoped, inferenceEpoch)) return [];
    return this.rankCandidates(scoped, refs);
  }

  private async searchRefs(
    input: ResolvedSearchInput,
  ): Promise<CandidateRef[] | typeof ABORTED | typeof MODEL_CHANGED> {
    const lexical = input.mode === "lexical";
    if (lexical) input.onFallback?.("lexical_only");
    const cached = input.includeSessions ? undefined : this.candidateIds.get(this.candidateKey(input));
    if (cached && this.now().getTime() < cached.nextValidityAt) return cached.refs;
    const vector = lexical ? null : await this.searchVector(input);
    if (vector === ABORTED || vector === MODEL_CHANGED) return vector;
    const refs = this.candidateRefs(input, vector);
    if (!input.includeSessions && (lexical || vector)) this.cacheCandidateRefs(input, refs);
    return refs;
  }

  private async searchVector(
    input: ResolvedSearchInput,
  ): Promise<Float32Array | null | typeof ABORTED | typeof MODEL_CHANGED> {
    const queryEpoch = this.queryEpoch;
    const embedder = this.embedder;
    const epoch = this.embeddingEpoch;
    const result = await raceAbort(this.queryVector(input.query, input.signal), input.signal);
    if (result === ABORTED || input.signal?.aborted || this.closed) return ABORTED;
    if (this.embedder !== embedder || this.embeddingEpoch !== epoch) {
      input.onFallback?.("model_changed");
      return MODEL_CHANGED;
    }
    if (this.queryEpoch !== queryEpoch) {
      input.onFallback?.("privacy_changed");
      return ABORTED;
    }
    if (!result.vector) input.onFallback?.(result.failure ?? "embedding_failed");
    return result.vector;
  }

  private cacheCandidateRefs(input: ResolvedSearchInput, refs: CandidateRef[]): void {
    const at = this.ts();
    const next = this.db
      .query<{ boundary: string | null }, [string, string]>(`SELECT min(boundary) AS boundary FROM (
      SELECT valid_from AS boundary FROM memories WHERE deleted_at IS NULL AND state='active' AND valid_from>?
      UNION ALL SELECT valid_until AS boundary FROM memories WHERE deleted_at IS NULL AND state='active' AND valid_until>?
    )`)
      .get(at, at);
    this.candidateIds.set(this.candidateKey(input), {
      refs,
      nextValidityAt: next?.boundary ? Date.parse(next.boundary) : Number.POSITIVE_INFINITY,
    });
  }

  private async rankCandidates(input: ResolvedSearchInput, refs: CandidateRef[]): Promise<SearchHit[]> {
    if (!this.searchPolicyCurrent(input)) return [];
    const inferenceEpoch = this.inferenceEpoch;
    const candidates = this.materializeCandidates(refs, input);
    if (input.includeSessions) {
      const sessions = searchSessions(this.db, {
        query: input.query,
        access: input.access,
        scope: input.scope,
        limit: input.maxCandidates,
      });
      candidates.push(...sessions.map((hit) => ({ hit, text: `${hit.title}\n${hit.preview}`, weight: 0.9 })));
    }
    const bounded = candidates.sort(compareCandidates).slice(0, input.maxCandidates);
    const ranked = await raceAbort(this.rerank(input.query, bounded, input), input.signal);
    if (inferenceEpoch !== this.inferenceEpoch) {
      input.onFallback?.("inference_changed");
      return [];
    }
    if (!this.searchPolicyCurrent(input)) return [];
    if (ranked === ABORTED || input.signal?.aborted || this.closed) return [];
    return this.finishSearch(
      ranked,
      input,
      new Map(refs.map((ref) => [ref.id, ref.revision])),
      new Map(refs.map((ref) => [ref.id, ref.rank])),
    );
  }

  private searchPolicyCurrent(input: SearchInput): boolean {
    if (input.policyRevision === undefined || input.policyRevision === this.retrievalPolicies.revision)
      return true;
    input.onFallback?.("policy_changed");
    return false;
  }

  private searchInvalidated(input: SearchInput, inferenceEpoch?: number): boolean {
    if (input.signal?.aborted || this.closed) return true;
    if (inferenceEpoch !== undefined && inferenceEpoch !== this.inferenceEpoch) {
      input.onFallback?.("inference_changed");
      return true;
    }
    return false;
  }

  private finishSearch(
    hits: SearchHit[],
    input: ResolvedSearchInput,
    revisions?: Map<number, number>,
    ranks?: Map<number, number>,
  ): SearchHit[] {
    if (input.signal?.aborted || this.closed) return [];
    const current = this.currentHits(hits, input, revisions, ranks).sort(compareHits).slice(0, input.limit);
    if (input.track) {
      this.markShown(current.flatMap((h) => (h.kind === "memory" ? [Number(h.id)] : [])));
    }
    return current;
  }

  private exactCandidates(
    input: SearchInput & { scope: SearchScope; maxCandidates: number },
  ): { refs: CandidateRef[]; candidates: Candidate[] } | null {
    const filter = input.access.memoryFilter(input.scope, input.type, this.ts(), input.recordKinds);
    const id = /^#?([1-9]\d*)$/.exec(input.query);
    const exactLimit = Math.min(EXACT_MATCH_LIMIT, input.maxCandidates);
    const condition = id ? "m.id = ?" : "(lower(m.title) = ? OR lower(m.topic_key) = ?)";
    const values: (string | number)[] = id ? [Number(id[1])] : [input.query, input.query];
    const refs = this.db
      .query<{ id: number; record_revision: number }, (string | number)[]>(
        `SELECT m.id,m.record_revision FROM memories m WHERE ${filter.where} AND ${condition}
       ORDER BY m.pinned DESC,m.id ASC LIMIT ?`,
      )
      .all(...filter.params, ...values, exactLimit + 1);
    if (!id && (refs.length === 0 || refs.length > exactLimit)) return null;
    const selected = refs.slice(0, exactLimit).map((row, index) => ({
      id: row.id,
      revision: row.record_revision,
      rank: 1 / (index + 1),
      similarity: null,
    }));
    return { refs: selected, candidates: this.materializeCandidates(selected, input) };
  }

  private candidateKey(input: SearchInput & { scope: SearchScope; maxCandidates: number }): string {
    return JSON.stringify([
      input.access.kind,
      input.access.reach(input.scope),
      input.scope,
      input.type ?? null,
      input.recordKinds ? [...input.recordKinds].sort() : null,
      input.query,
      input.mode ?? "hybrid",
      input.maxCandidates,
      input.policyRevision ?? this.retrievalPolicies.revision,
      this.queryFingerprint(),
      this.retrievalGeneration,
    ]);
  }

  private candidateRefs(
    input: SearchInput & { scope: SearchScope; maxCandidates: number },
    queryVector: Float32Array | null,
  ): CandidateRef[] {
    const filter = input.access.memoryFilter(input.scope, input.type, this.ts(), input.recordKinds);
    const ranks = new Map<number, number>();
    addRanks(ranks, this.keywordIds(input.query, filter, input.maxCandidates));
    if (input.query.length < 3 || ranks.size === 0) {
      addRanks(ranks, this.likeIds(input.query, filter, input.maxCandidates));
    }
    const near = queryVector ? this.vectorNeighbors(queryVector, input) : [];
    addRanks(
      ranks,
      near.map((n) => n.id),
    );
    const similarities = new Map(near.map((n) => [n.id, n.similarity]));
    const ids = [...ranks]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, input.maxCandidates)
      .map(([id]) => id);
    if (ids.length === 0) return [];
    return this.db
      .query<{ id: number; record_revision: number }, (string | number)[]>(
        `SELECT m.id,m.record_revision FROM memories m WHERE ${filter.where}
       AND m.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...filter.params, ...ids)
      .map((row) => ({
        id: row.id,
        revision: row.record_revision,
        rank: ranks.get(row.id) ?? 0,
        similarity: similarities.get(row.id) ?? null,
      }));
  }

  private materializeCandidates(
    refs: CandidateRef[],
    input: { access: Access; scope: SearchScope; type?: string; recordKinds?: RecordKind[] },
  ): Candidate[] {
    if (refs.length === 0) return [];
    const filter = input.access.memoryFilter(input.scope, input.type, this.ts(), input.recordKinds);
    const byId = new Map(refs.map((ref) => [ref.id, ref]));
    const rows = this.db
      .query<MemoryWithProject, (string | number)[]>(
        `SELECT m.*,p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key=m.project_key
       WHERE ${filter.where} AND m.id IN (${refs.map(() => "?").join(",")})`,
      )
      .all(...filter.params, ...refs.map((ref) => ref.id));
    this.feedback.projectCurrentHints(rows);
    const nowMs = this.now().getTime();
    return rows
      .flatMap((row): Candidate[] => {
        const ref = byId.get(row.id);
        if (!ref || ref.revision !== row.record_revision) return [];
        const weight = boost(row, nowMs, this.config.usageRanking);
        return [
          {
            hit: memoryHit(row, { score: ref.rank * weight, similarity: ref.similarity }),
            text: `${row.title}\n${row.content}`,
            weight,
          },
        ];
      })
      .sort(compareCandidates);
  }

  private currentHits(
    hits: SearchHit[],
    input: { access: Access; scope: SearchScope; type?: string; recordKinds?: RecordKind[] },
    revisions?: Map<number, number>,
    ranks?: Map<number, number>,
  ): SearchHit[] {
    this.feedback.expire();
    const filter = input.access.memoryFilter(input.scope, input.type, this.ts(), input.recordKinds);
    const memoryIds = hits.flatMap((h) => (h.kind === "memory" ? [Number(h.id)] : []));
    const rows =
      memoryIds.length === 0
        ? []
        : this.db
            .prepare<MemoryWithProject, (string | number)[]>(
              `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
               WHERE ${filter.where} AND m.id IN (${memoryIds.map(() => "?").join(",")})`,
            )
            .all(...filter.params, ...memoryIds);
    this.feedback.projectCurrentHints(rows);
    const memories = new Map(rows.map((row) => [row.id, row]));
    const nowMs = this.now().getTime();
    const sessionIds = hits.flatMap((h) => (h.kind === "session" ? [h.id] : []));
    const sessions = currentSessionHits(this.db, input.access.sessionFilter(input.scope), sessionIds);
    return hits.flatMap((hit): SearchHit[] => {
      if (hit.kind === "session") return currentSessionHit(hit, sessions);
      const row = memories.get(Number(hit.id));
      if (!row || (revisions && revisions.get(row.id) !== row.record_revision)) return [];
      const rank = ranks?.get(row.id);
      const score =
        rank === undefined
          ? hit.score
          : (hit.relevance ?? rank) * boost(row, nowMs, this.config.usageRanking);
      return [{ ...memoryHit(row, { score, similarity: hit.similarity }), relevance: hit.relevance }];
    });
  }

  recordTurn(input: TurnInput): boolean {
    if (this.sessionInvalidated(input.agentId)) return false;
    if (input.project) this.upsertProject(input.project);
    this.audit.retitle(input.agentId, input.title);
    return recordTurn(this.db, input, this.ts());
  }

  sessionInvalidated(agentId: string): boolean {
    return this.lifecycle.contextInvalidated({ agentId });
  }

  sessions(input: { projectKey: string | null; query: string; limit: number }): SessionRow[] {
    return listSessions(this.db, input);
  }

  storeReview(review: SessionReview): boolean {
    return storeReview(this.db, review, this.ts());
  }

  endSession(agentId: string): void {
    this.db
      .query(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(this.ts(), agentId);
  }

  recentSessions(projectKey: string | null, limit: number, excludeAgentId?: string): SessionRow[] {
    return this.db
      .query<SessionRow, [string, string, number]>(
        `SELECT * FROM sessions WHERE ifnull(project_key, '') = ? AND id != ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(projectKey ?? "", excludeAgentId ?? "", limit);
  }

  visibleSessions(access: Access, ids: string[], scope: SearchScope = "all"): SessionRow[] {
    const filter = access.sessionFilter(scope);
    if (!filter || ids.length === 0) return [];
    return this.db
      .query<SessionRow, (string | number)[]>(`SELECT s.* FROM sessions s
      WHERE ${filter.where} AND s.id IN (${ids.map(() => "?").join(",")})`)
      .all(...filter.params, ...ids);
  }

  pruneHistory(retentionDays: number): { sessions: number; audit: number } {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    this.db.transaction(() => pruneRetiredIndexes(this.db, this.ts())).immediate();
    // bun:sqlite `changes` includes rows the FTS triggers touch, so count the deleted ids instead.
    const sessions = this.db
      .query(`DELETE FROM sessions WHERE updated_at < ? RETURNING id`)
      .all(cutoff).length;
    return { sessions, audit: this.audit.prune(cutoff) };
  }

  stats(): { memories: number; sessions: number; projects: number } {
    const one = (sql: string) => this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      memories: one(`SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL`),
      sessions: one(`SELECT count(*) AS n FROM sessions`),
      projects: one(`SELECT count(*) AS n FROM projects`),
    };
  }

  pendingEmbeddings(): number {
    const vectors = this.vectors;
    if (!vectors) return 0;
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.index_fingerprint = ?
         WHERE m.deleted_at IS NULL AND ${currentLifecycleSql()} AND ${STALE_VECTOR_SQL}`,
      )
      .get(vectors.fingerprint);
    return row?.n ?? 0;
  }

  /** Pending work plus whether embedding is failing; exposed in the service status so a stuck index is visible. */
  indexHealth(): IndexHealth {
    const generationOf = this.db.query<{ index_generation: number }, [number]>(
      `SELECT index_generation FROM memories WHERE id = ? AND deleted_at IS NULL`,
    );
    const summary = this.retry.summary((id) => generationOf.get(id)?.index_generation ?? null);
    return { pending: this.pendingEmbeddings(), ...summary, degraded: summary.retrying + summary.failed > 0 };
  }

  embeddingModels(): { model: string; dims: number; count: number }[] {
    return this.db
      .query<{ model: string; dims: number; count: number }, []>(
        `SELECT i.model,i.dims,count(DISTINCT e.memory_id) AS count FROM memory_embeddings e
         JOIN embedding_indexes i ON i.fingerprint=e.index_fingerprint GROUP BY i.model,i.dims ORDER BY i.model`,
      )
      .all();
  }

  vecTables(): { model: string; dims: number; table_name: string }[] {
    return vecTables(this.db);
  }

  async indexPending(): Promise<void> {
    while (this.indexing) await this.indexing;
    this.scheduleIndex();
    while (this.indexing) await this.indexing;
  }

  private saveNow(draft: SaveDraft): SaveResult {
    if (draft.input.project) this.upsertProject(draft.input.project);
    return (
      this.updateByTopic(draft) ??
      this.countExactDuplicate(draft) ??
      this.nearDuplicates(draft) ??
      this.insert(draft)
    );
  }

  private updateByTopic(draft: SaveDraft): SaveResult | null {
    if (!draft.topicKey) return null;
    const existing = this.db
      .query<MemoryRow, [string, string, string]>(
        `SELECT * FROM memories WHERE scope = ? AND ifnull(project_key, '') = ? AND topic_key = ? AND deleted_at IS NULL`,
      )
      .get(draft.scope, draft.projectKey ?? "", draft.topicKey);
    if (!existing) return null;
    // Saving the same text to a topic again is a duplicate, not a revision.
    if (existing.content_hash === draft.hash && (!draft.input.pinned || existing.pinned === 1)) return null;
    this.lifecycle.invalidate({ id: existing.id, revision: existing.record_revision });
    const { input } = draft;
    this.db
      .query(
        `UPDATE memories SET title = ?, content = ?, type = ?, content_hash = ?, pinned = max(pinned, ?),
         revision_count = revision_count + 1, record_revision = record_revision + 1,
         index_generation = index_generation + 1, updated_at = ?, agent_id = coalesce(?, agent_id),
         provider = coalesce(?, provider), workspace_dir = coalesce(?, workspace_dir) WHERE id = ?`,
      )
      .run(
        draft.title,
        draft.content,
        input.type,
        draft.hash,
        input.pinned ? 1 : 0,
        this.ts(),
        input.agentId ?? null,
        input.provider ?? null,
        input.workspaceDir ?? null,
        existing.id,
      );
    this.storeVector(this.target(existing.id, draft, existing.index_generation + 1), draft.vector);
    this.advanceRetrieval();
    return { status: "updated", id: existing.id };
  }

  private countExactDuplicate(draft: SaveDraft): SaveResult | null {
    const same = this.db
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM memories WHERE content_hash = ? AND scope = ? AND ifnull(project_key, '') = ? AND deleted_at IS NULL`,
      )
      .get(draft.hash, draft.scope, draft.projectKey ?? "");
    if (!same) return null;
    this.db
      .query(`UPDATE memories SET duplicate_count = duplicate_count + 1, last_seen_at = ? WHERE id = ?`)
      .run(this.ts(), same.id);
    return { status: "duplicate", id: same.id };
  }

  private nearDuplicates(draft: SaveDraft): SaveResult | null {
    if (!draft.vector || !this.vectors || draft.input.force || draft.topicKey) return null;
    const candidates = this.closeMatches(draft.vector, scopeKey(draft.scope, draft.projectKey));
    const same = candidates.find((c) => c.type === draft.input.type);
    if (same)
      return { status: "near_duplicate", id: same.id, title: same.title, similarity: same.similarity };
    if (candidates.length === 0) return null;
    return {
      status: "possible_duplicate",
      id: null,
      candidates: candidates.map(({ id, title, similarity }) => ({ id, title, similarity })),
    };
  }

  private closeMatches(
    vector: Float32Array,
    partition: string,
    options: { excludeId?: number; access?: Access } = {},
  ): { id: number; title: string; type: string; similarity: number; revision: number }[] {
    if (!this.vectors) return [];
    const threshold = this.vectors.spec.duplicateThreshold;
    const near = this.vectors
      .knn(vector, partition, 4)
      .filter((n) => n.id !== options.excludeId && n.similarity >= threshold);
    const rows = new Map(this.rowsById(near.map((n) => n.id)).map((r) => [r.id, r]));
    return near.flatMap((n) => {
      const row = rows.get(n.id);
      if (!row || (options.access && !options.access.allows("read", namespaceOf(row)))) return [];
      return [
        {
          id: n.id,
          title: row.title,
          type: row.type,
          similarity: Math.round(n.similarity * 1000) / 1000,
          revision: row.record_revision,
        },
      ];
    });
  }

  private similarTo(row: MemoryRow, access: Access): MemoryDetail["duplicates"] {
    const partition = scopeKey(row.scope, row.project_key);
    const vector = this.vectors?.vector(row.id, row.content_hash, row.index_generation);
    if (!vector) return [];
    return this.closeMatches(vector, partition, { excludeId: row.id, access }).map(
      ({ id, title, similarity, revision }) => ({ id, title, similarity, revision }),
    );
  }

  liveRows(access: Access): MemoryWithProject[] {
    this.feedback.expire();
    const filter = access.memoryFilter("all", undefined, this.ts());
    const rows = this.db
      .query<MemoryWithProject, (string | number)[]>(
        `SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.key = m.project_key
         WHERE ${filter.where} ORDER BY m.id`,
      )
      .all(...filter.params);
    this.feedback.projectCurrentHints(rows);
    return rows;
  }

  nearDuplicatesOf(row: MemoryRow): Neighbor[] {
    const vector = this.vectors?.vector(row.id, row.content_hash, row.index_generation);
    if (!vector || !this.vectors) return [];
    const threshold = this.vectors.spec.duplicateThreshold;
    return this.vectors
      .knn(vector, scopeKey(row.scope, row.project_key), 6)
      .filter((n) => n.id !== row.id && n.similarity >= threshold);
  }

  dismissedPairs(): Set<string> {
    const rows = this.db
      .query<{ low_id: number; high_id: number }, []>(`SELECT low_id, high_id FROM upkeep_dismissed`)
      .all();
    return new Set(rows.map((r) => `${r.low_id}:${r.high_id}`));
  }

  dismissPair(a: number, b: number): void {
    this.db
      .query(`INSERT OR IGNORE INTO upkeep_dismissed (low_id, high_id, created_at) VALUES (?, ?, ?)`)
      .run(Math.min(a, b), Math.max(a, b), this.ts());
  }

  getMeta(key: string): string | null {
    return (
      this.db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ??
      null
    );
  }

  private insert(draft: SaveDraft): SaveResult {
    const { input } = draft;
    const ts = this.ts();
    const result = this.db
      .query(
        `INSERT INTO memories (scope, project_key, type, title, content, topic_key, content_hash, pinned,
          source, agent_id, provider, workspace_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.scope,
        draft.projectKey,
        input.type,
        draft.title,
        draft.content,
        draft.topicKey,
        draft.hash,
        input.pinned ? 1 : 0,
        input.source ?? "agent",
        input.agentId ?? null,
        input.provider ?? null,
        input.workspaceDir ?? null,
        ts,
        ts,
      );
    const id = Number(result.lastInsertRowid);
    this.storeVector(this.target(id, draft, 1), draft.vector);
    this.advanceRetrieval();
    return { status: "created", id };
  }

  private target(id: number, draft: SaveDraft, generation: number): VectorTarget {
    return { id, partition: scopeKey(draft.scope, draft.projectKey), hash: draft.hash, generation };
  }

  private storeVector(target: VectorTarget, vector: Float32Array | null): void {
    if (!this.vectors) return;
    if (vector) this.vectors.write(target, vector);
    else this.scheduleIndex();
  }

  private async embedOne(
    text: string,
    kind: EmbedKind,
    options: { signal?: AbortSignal; failed?: (reason: string) => void } = {},
  ): Promise<Float32Array | null> {
    const embedder = this.embedder;
    const epoch = this.embeddingEpoch;
    if (!embedder) return null;
    try {
      const vector = await this.inference.run(
        kind === "query" ? "query_embedding" : "document_embedding",
        async (signal) => {
          if (signal.aborted || this.closed || this.embedder !== embedder || this.embeddingEpoch !== epoch)
            throw new InferenceQueueError("inference_cancelled");
          return (await embedder.embed([text], kind))[0] ?? null;
        },
        { signal: options.signal },
      );
      return this.embedder === embedder && this.embeddingEpoch === epoch && !this.closed ? vector : null;
    } catch (error) {
      options.failed?.(error instanceof InferenceQueueError ? error.code : "embedding_failed");
      this.log.warn(`${kind} embedding failed, continuing without a vector: ${errorText(error)}`);
      return null;
    }
  }

  private keywordIds(query: string, filter: SqlFilter, limit: number): number[] {
    const fts = ftsQuery(query);
    if (!fts) return [];
    return this.db
      .query<{ id: number }, (string | number)[]>(
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND ${filter.where}
         ORDER BY bm25(memories_fts, 5.0, 1.0, 3.0),m.id ASC LIMIT ?`,
      )
      .all(fts, ...filter.params, limit)
      .map((r) => r.id);
  }

  private likeIds(query: string, filter: SqlFilter, limit: number): number[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .query<{ id: number }, (string | number)[]>(
        `SELECT m.id FROM memories m WHERE (m.title LIKE ? OR m.content LIKE ? OR m.topic_key LIKE ?)
         AND ${filter.where} ORDER BY m.updated_at DESC,m.id ASC LIMIT ?`,
      )
      .all(like, like, like, ...filter.params, limit)
      .map((r) => r.id);
  }

  private vectorNeighbors(
    vector: Float32Array,
    input: {
      access: Access;
      scope: SearchScope;
      type?: string;
      recordKinds?: RecordKind[];
      maxCandidates: number;
    },
  ): Neighbor[] {
    const vectors = this.vectors;
    if (!vectors) return [];
    const filter = input.access.memoryFilter(input.scope, input.type, this.ts(), input.recordKinds);
    // Filter IDs before KNN so unrelated namespaces/kinds cannot consume the bounded neighbor set.
    const near = this.db
      .query<{ memory_id: number; distance: number }, (string | number | Uint8Array)[]>(
        `SELECT memory_id,distance FROM ${vectors.table}
       WHERE embedding MATCH ? AND k=? AND memory_id IN (
         SELECT m.id FROM memories m JOIN memory_embeddings e ON e.memory_id=m.id
         AND e.index_fingerprint=? AND e.index_generation=m.index_generation
         AND e.content_hash=m.content_hash WHERE ${filter.where}
       )`,
      )
      .all(
        new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
        input.maxCandidates,
        vectors.fingerprint,
        ...filter.params,
      )
      .map((row) => ({ id: Number(row.memory_id), similarity: 1 - row.distance }))
      .sort((a, b) => b.similarity - a.similarity || a.id - b.id);
    const { min, relative } = vectors.spec.searchFloor;
    const floor = Math.max(min, (near[0]?.similarity ?? 0) * relative);
    return near.filter((neighbor) => neighbor.similarity >= floor);
  }

  private async rerank(
    query: string,
    candidates: Candidate[],
    input: ResolvedSearchInput,
  ): Promise<SearchHit[]> {
    const { onFallback } = input;
    const disabled = input.mode === "lexical" || input.rerankMode === "off";
    const fused = candidates.sort(compareCandidates);
    const reranker = this.reranker;
    if (disabled || fused.length < 2) return fused.map((c) => c.hit);
    if (!reranker) {
      onFallback?.("reranker_unavailable");
      return fused.map((c) => c.hit);
    }
    const head = fused.slice(0, RERANK_CANDIDATES);
    const epoch = this.inferenceEpoch;
    try {
      const result = await this.inference.run(
        "rerank",
        async (signal) => {
          if (signal.aborted || this.searchInvalidated(input, epoch) || !this.searchPolicyCurrent(input))
            throw new InferenceQueueError("inference_cancelled");
          const revisions = new Map(
            head.flatMap((c) =>
              c.hit.kind === "memory" ? [[Number(c.hit.id), c.hit.revision] as const] : [],
            ),
          );
          const visible = new Set(
            this.currentHits(
              head.map((c) => c.hit),
              input,
              revisions,
            ).map((hit) => `${hit.kind}:${hit.id}`),
          );
          const selected = head.filter((c) => visible.has(`${c.hit.kind}:${c.hit.id}`));
          if (selected.length < 2)
            throw new InferenceQueueError("inference_cancelled", "Candidates changed before reranking.");
          return {
            selected,
            scores: await reranker.score(
              query,
              selected.map((c) => c.text),
            ),
          };
        },
        { signal: input.signal },
      );
      const { selected, scores } = result;
      return selected.map((c, i): SearchHit => {
        const relevance = scores[i] ?? 0;
        return c.hit.kind === "memory"
          ? { ...c.hit, score: relevance, relevance }
          : { ...c.hit, score: relevance * c.weight };
      });
    } catch (error) {
      this.log.warn(`re-ranking failed, using fused order: ${errorText(error)}`);
      onFallback?.(error instanceof InferenceQueueError ? error.code : "rerank_failed");
      return fused.map((c) => c.hit);
    }
  }

  private scheduleIndex(): void {
    if (!this.embedder || this.closed) return;
    if (this.indexing) {
      this.indexAgain = true;
      return;
    }
    this.indexing = Promise.resolve()
      .then(() => this.runIndex())
      .catch((error: unknown) => this.log.warn(`background embedding failed: ${errorText(error)}`))
      .finally(() => {
        this.indexing = null;
        if (!this.indexAgain) return;
        this.indexAgain = false;
        this.scheduleIndex();
      });
  }

  private async runIndex(): Promise<void> {
    const embedder = this.embedder;
    const vectors = this.vectors;
    if (!embedder || !vectors) return;
    let done = 0;
    let after = 0;
    while (!this.closed && this.embedder === embedder) {
      const rows = this.pendingBatch(vectors, after);
      if (rows.length === 0) break;
      after = rows.at(-1)?.id ?? Number.MAX_SAFE_INTEGER;
      done += await this.indexRows(embedder, vectors, rows);
    }
    if (
      !this.closed &&
      this.vectors === vectors &&
      this.embedder === embedder &&
      this.pendingEmbeddings() === 0
    )
      vectors.finish();
    if (done > 0) this.log.info(`embedded ${done} memories with ${embedder.spec.model}`);
  }

  private async indexRows(embedder: Embedder, vectors: VectorIndex, rows: IndexRow[]): Promise<number> {
    const runnable = rows.filter((row) => this.retry.canAttempt(row));
    if (runnable.length === 0) return 0;
    const outcome = await this.embedBatch(embedder, runnable);
    // A model switch or close while embedding makes the result useless for the current index.
    if (this.closed || this.embedder !== embedder) return 0;
    if (outcome.ok) return this.writeBatch(vectors, runnable, outcome.vectors);
    if (outcome.cancelled) {
      this.scheduleIndex();
      return 0;
    }
    this.retry.failed(runnable, outcome.error, () => this.scheduleIndex());
    return 0;
  }

  private async embedBatch(
    embedder: Embedder,
    rows: IndexRow[],
  ): Promise<{ ok: true; vectors: Float32Array[] } | { ok: false; error: string; cancelled: boolean }> {
    try {
      const vectors = await this.inference.run("document_embedding", async (signal) => {
        if (signal.aborted || this.closed || this.embedder !== embedder)
          throw new InferenceQueueError("inference_cancelled");
        const current = this.db.query<IndexRow & { deleted_at: string | null }, [number]>(
          `SELECT id,title,content,scope,project_key,content_hash,index_generation,deleted_at
           FROM memories m WHERE id=? AND ${currentLifecycleSql()}`,
        );
        const texts = rows.map((row) => {
          const now = current.get(row.id);
          if (!now || !sameIndexState(now, row))
            throw new InferenceQueueError("inference_cancelled", "Sources changed before embedding.");
          return `${now.title}\n${now.content}`;
        });
        return embedder.embed(texts, "document");
      });
      return { ok: true, vectors };
    } catch (error) {
      const cancelled =
        error instanceof InferenceQueueError &&
        (error.code === "inference_cancelled" || error.code === "inference_closed");
      return { ok: false, error: errorText(error), cancelled };
    }
  }

  private pendingBatch(vectors: VectorIndex, afterId: number): IndexRow[] {
    return this.db
      .query<IndexRow, [string, number, number]>(
        `SELECT m.id, m.title, m.content, m.scope, m.project_key, m.content_hash, m.index_generation FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.index_fingerprint = ?
         WHERE m.deleted_at IS NULL AND ${currentLifecycleSql()} AND m.id > ? AND ${STALE_VECTOR_SQL}
         ORDER BY m.id LIMIT ?`,
      )
      .all(vectors.fingerprint, afterId, INDEX_BATCH);
  }

  // The vector commits only if the row still has the generation, namespace, text and lifecycle the batch started
  // from; otherwise the row is still pending and the next pass embeds its current state.
  private writeBatch(vectors: VectorIndex, rows: IndexRow[], results: Float32Array[]): number {
    const current = this.db.query<IndexRow & { deleted_at: string | null }, [number]>(
      `SELECT id, title, content, scope, project_key, content_hash, index_generation, deleted_at
       FROM memories m WHERE id = ? AND ${currentLifecycleSql()}`,
    );
    const outcomes = this.db.transaction(() =>
      rows.map((row, i) => this.commitVector(vectors, { row, now: current.get(row.id) ?? null }, results[i])),
    )();
    if (outcomes.includes("stale")) this.scheduleIndex();
    const written = outcomes.filter((outcome) => outcome === "written").length;
    if (written > 0) this.advanceRetrieval();
    return written;
  }

  private commitVector(
    vectors: VectorIndex,
    { row, now }: { row: IndexRow; now: (IndexRow & { deleted_at: string | null }) | null },
    vector: Float32Array | undefined,
  ): "written" | "stale" | "missing" {
    if (!vector) {
      this.retry.failed([row], "the embedder returned no vector", () => this.scheduleIndex());
      return "missing";
    }
    if (!now || !sameIndexState(now, row)) return "stale";
    const partition = scopeKey(now.scope, now.project_key);
    vectors.write(
      { id: row.id, partition, hash: now.content_hash, generation: now.index_generation },
      vector,
    );
    this.retry.succeeded(row.id);
    return "written";
  }

  private bump(ids: number[], set: string, params: string[]): void {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    this.db
      .prepare(
        `UPDATE memories SET ${set} WHERE deleted_at IS NULL AND id IN (${unique.map(() => "?").join(",")})`,
      )
      .run(...params, ...unique);
  }

  private removed(id: number): RemovedRow | null {
    return this.db
      .query<RemovedRow, [number]>(
        `SELECT scope, project_key, merged_into, archived_at FROM memories WHERE id = ?`,
      )
      .get(id);
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  lifecycleDetail(access: Access, id: number): LifecycleDetail | null {
    const row = this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE id=?").get(id);
    if (!row || !access.allows("read", namespaceOf(row))) return null;
    const revisions = this.db
      .query<
        {
          revision: number;
          snapshot: string;
          changed_at: string;
          actor_id: string | null;
          reason: string | null;
          legacy_metadata_unknown: number;
        },
        [number]
      >("SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC LIMIT 100")
      .all(id)
      .flatMap((revision) => {
        const snapshot = JSON.parse(revision.snapshot) as Record<string, unknown>;
        if (!snapshot.scope && access.kind !== "owner") return [];
        if (
          snapshot.scope &&
          !access.allows("read", {
            scope: snapshot.scope as Scope,
            projectKey: snapshot.project_key as string | null,
          })
        )
          return [];
        return [
          {
            revision: revision.revision,
            snapshot,
            changedAt: revision.changed_at,
            actorId: revision.actor_id,
            reason: revision.reason,
            legacyMetadataUnknown: Boolean(revision.legacy_metadata_unknown),
          },
        ];
      });
    const evidenceIds = this.db
      .query<{ evidence_id: string }, [number, number]>(
        "SELECT evidence_id FROM memory_evidence_links WHERE memory_id=? AND revision=?",
      )
      .all(id, row.record_revision)
      .map((e) => e.evidence_id);
    return {
      memoryRef: { id, revision: row.record_revision },
      recordKind: row.record_kind,
      state: row.state,
      verificationStatus: row.verification_status,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      verifiedAt: row.verified_at,
      evidence: this.provenance.getVisible(access, evidenceIds),
      revisions,
    };
  }

  historical(access: Access, id: number, asOf: string): MemoryRow | null {
    const current = this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE id=?").get(id);
    if (!current || !access.allows("read", namespaceOf(current))) return null;
    const revision = this.db
      .query<{ snapshot: string; legacy_metadata_unknown: number }, [number, string]>(
        "SELECT snapshot,legacy_metadata_unknown FROM memory_revisions WHERE memory_id=? AND julianday(changed_at)<=julianday(?) ORDER BY revision DESC LIMIT 1",
      )
      .get(id, asOf);
    if (!revision) return null;
    const row = JSON.parse(revision.snapshot) as MemoryRow;
    if (!row.scope) return null;
    if (
      !access.allows("read", namespaceOf(row)) ||
      row.state !== "active" ||
      row.deleted_at ||
      (row.valid_from && Date.parse(row.valid_from) > Date.parse(asOf)) ||
      (row.valid_until && Date.parse(row.valid_until) <= Date.parse(asOf))
    )
      return null;
    if (!this.lifecycle.historicalSourcesValid({ id: row.id, revision: row.record_revision }, asOf))
      return null;
    return row;
  }

  authorizedTopic(
    access: Access,
    scope: Scope,
    projectKey: string | null,
    topicKey: string,
  ): MemoryRow | null {
    if (!access.allows("write", { scope, projectKey })) return null;
    return this.db
      .query<MemoryRow, [string, string, string]>(
        "SELECT * FROM memories WHERE scope=? AND ifnull(project_key,'')=? AND topic_key=? AND deleted_at IS NULL",
      )
      .get(scope, projectKey ?? "", topicKey);
  }

  invalidateSource(access: Access, sourceRef: string): { affected: number } {
    if (access.kind !== "owner") throw new Error("Only the owner can invalidate a source.");
    return this.db.transaction(() => {
      const rows = this.db
        .query<{ id: number; record_revision: number }, [string]>(`SELECT DISTINCT m.id,m.record_revision
        FROM memory_evidence e JOIN memory_evidence_links l ON l.evidence_id=e.evidence_id
        JOIN memories m ON m.id=l.memory_id AND m.record_revision=l.revision WHERE e.source_ref=? AND m.state!='needs_recheck'`)
        .all(sourceRef);
      this.db
        .query(
          "UPDATE memory_evidence SET status='unresolved',reason='source_changed',excerpt=NULL WHERE source_ref=?",
        )
        .run(sourceRef);
      const evidenceIds = this.db
        .query<{ evidence_id: string }, [string]>(
          "SELECT evidence_id FROM memory_evidence WHERE source_ref=?",
        )
        .all(sourceRef)
        .map((row) => row.evidence_id);
      retractFeedbackEvidence(this.db, evidenceIds, "invalidate");
      for (const row of rows) {
        this.lifecycle.markForRecheck({ id: row.id, revision: row.record_revision });
        this.lifecycle.invalidate({ id: row.id, revision: row.record_revision });
      }
      this.db
        .query(`UPDATE review_jobs SET state='cancelled',lease_version=lease_version+1,updated_at=?
        WHERE state IN ('queued','reserved','running') AND id IN (SELECT s.job_id FROM review_job_sources s
          JOIN memory_evidence e ON e.evidence_id=s.evidence_id WHERE e.source_ref=?)`)
        .run(this.ts(), sourceRef);
      this.advanceRetrieval();
      return { affected: rows.length };
    })();
  }

  forgetSource(access: Access, sourceRef: string, requestId: string): { forgotten: number } {
    if (access.kind !== "owner") throw new Error("Only the owner can forget a source.");
    return this.db.transaction(() => {
      const key = `source-forget:${requestId}`;
      const hash = sha256(canonicalBody({ sourceRef }));
      const prior = this.db
        .query<{ request_body_hash: string; result: string }, [string]>(
          "SELECT request_body_hash,result FROM memory_mutations WHERE principal_id='owner' AND request_id=?",
        )
        .get(key);
      if (prior) {
        if (prior.request_body_hash !== hash)
          throw new MutationError(
            "request_conflict",
            "This source-forget request ID was already used for another source.",
          );
        return JSON.parse(prior.result) as { forgotten: number };
      }
      const rows = this.db
        .query<{ id: number; record_revision: number }, [string]>(`SELECT DISTINCT m.id,m.record_revision
        FROM memory_evidence e JOIN memory_evidence_links l ON l.evidence_id=e.evidence_id
        JOIN memories m ON m.id=l.memory_id WHERE e.source_ref=?`)
        .all(sourceRef);
      this.db
        .query("INSERT OR IGNORE INTO memory_tombstones VALUES ('source',?,?, 'owner')")
        .run(sourceRef, this.ts());
      let forgotten = 0;
      for (const row of rows) {
        if (!this.db.query("SELECT 1 FROM memories WHERE id=?").get(row.id)) continue;
        const affected = this.lifecycle.preview(access, row.id).records.length;
        this.mutations.mutate(ownerMutation(access), {
          requestId: `${requestId}:${row.id}`,
          operation: "forget",
          id: row.id,
          expectedRevision: row.record_revision,
          reason: "Owner source forget",
        });
        forgotten += affected;
      }
      const evidenceIds = this.db
        .query<{ evidence_id: string }, [string]>(
          "SELECT evidence_id FROM memory_evidence WHERE source_ref=?",
        )
        .all(sourceRef)
        .map((row) => row.evidence_id);
      retractFeedbackEvidence(this.db, evidenceIds, "forget");
      this.db.query("DELETE FROM source_artifacts WHERE source_ref=?").run(sourceRef);
      this.db
        .query(
          "DELETE FROM memory_evidence_links WHERE evidence_id IN (SELECT evidence_id FROM memory_evidence WHERE source_ref=?)",
        )
        .run(sourceRef);
      this.db.query("DELETE FROM memory_evidence WHERE source_ref=?").run(sourceRef);
      this.db
        .query(`INSERT INTO memory_mutations
        (principal_id,request_id,request_body_hash,operation,memory_id,resulting_revision,result,created_at,actor_id,reason)
        VALUES ('owner',?,?,'source_forget',0,0,?,?,'owner','Owner source forget')`)
        .run(key, hash, JSON.stringify({ forgotten }), this.ts());
      this.clearQueryCache();
      this.advanceRetrieval();
      return { forgotten };
    })();
  }
  private ts(): string {
    return this.now().toISOString();
  }
}

function boundedCount(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? Math.floor(value ?? fallback) : fallback));
}

function compareHits(a: SearchHit, b: SearchHit): number {
  return (
    b.score - a.score ||
    a.kind.localeCompare(b.kind) ||
    (a.kind === "memory" && b.kind === "memory" ? Number(a.id) - Number(b.id) : a.id.localeCompare(b.id))
  );
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return compareHits(a.hit, b.hit);
}

function currentSessionHit(hit: SessionHit, sessions: ReadonlyMap<string, SessionHit>): SessionHit[] {
  const fresh = sessions.get(hit.id);
  return fresh && fresh.version === hit.version ? [{ ...fresh, score: hit.score }] : [];
}

const ABORTED = Symbol("aborted");
const MODEL_CHANGED = Symbol("model changed");

function resolvedSearch(input: SearchInput): ResolvedSearchInput | null {
  const maxCandidates = boundedCount(input.maxCandidates, 60, MAX_SEARCH_CANDIDATES);
  const limit = boundedCount(input.limit, 8, maxCandidates);
  if (limit === 0 || maxCandidates === 0 || input.recordKinds?.length === 0) return null;
  return {
    ...input,
    scope: input.scope ?? "all",
    limit,
    maxCandidates,
    query: input.query.trim().replace(/\s+/g, " ").toLowerCase(),
  };
}

function waitForQuery(flight: QueryFlight, signal?: AbortSignal): Promise<QueryVectorResult> {
  const { promise, resolve } = Promise.withResolvers<QueryVectorResult>();
  flight.consumers += 1;
  let settled = false;
  const finish = (value: QueryVectorResult) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    flight.consumers -= 1;
    if (flight.consumers === 0 && !flight.settled) flight.controller.abort();
    resolve(value);
  };
  const onAbort = () => finish({ vector: null, failure: "inference_cancelled" });
  signal?.addEventListener("abort", onAbort, { once: true });
  void flight.work.then(finish, () => finish({ vector: null, failure: "embedding_failed" }));
  if (signal?.aborted) onAbort();
  return promise;
}

// Backends that cannot cancel keep running; the caller just stops waiting for them.
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(ABORTED);
  const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
  const onAbort = () => resolve(ABORTED);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([work, promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

function sameIndexState(now: IndexRow & { deleted_at: string | null }, batch: IndexRow): boolean {
  return (
    now.deleted_at === null &&
    now.index_generation === batch.index_generation &&
    now.content_hash === batch.content_hash &&
    now.scope === batch.scope &&
    now.project_key === batch.project_key
  );
}

// The embedding depends on type, text and namespace; any of them changing invalidates in-flight index batches.
function classifyChange(existing: MemoryRow, next: ReturnType<typeof patched>) {
  const textChanged = next.title !== existing.title || next.content !== existing.content;
  const reindex =
    next.hash !== existing.content_hash ||
    next.scope !== existing.scope ||
    next.projectKey !== existing.project_key;
  const changed = reindex || next.pinned !== existing.pinned || next.topicKey !== existing.topic_key;
  return { textChanged, reindex, changed };
}

function namespaceOf(row: { scope: Scope; project_key: string | null }): Namespace {
  return { scope: row.scope, projectKey: row.project_key };
}

function patched(existing: MemoryRow, patch: MemoryPatch) {
  const title = patch.title !== undefined ? redact(patch.title).trim() : existing.title;
  const content = patch.content !== undefined ? redact(patch.content).trim() : existing.content;
  const type = patch.type ?? existing.type;
  const pinnedFlag = patch.pinned === undefined ? existing.pinned : Number(patch.pinned);
  return {
    title,
    content,
    type,
    pinned: pinnedFlag,
    topicKey: patch.topicKey === undefined ? existing.topic_key : patch.topicKey,
    hash: sha256(`${type}\n${title}\n${content}`),
    ...patchedScope(existing, patch),
  };
}

function patchedScope(
  existing: MemoryRow,
  patch: MemoryPatch,
): { scope: Scope; projectKey: string | null; project: ProjectRef | null } {
  if (patch.scope === undefined)
    return { scope: existing.scope, projectKey: existing.project_key, project: null };
  if (patch.scope === "global") return { scope: "global", projectKey: null, project: null };
  const project = patch.project ?? null;
  const projectKey = project?.key ?? (existing.scope === "project" ? existing.project_key : null);
  if (!projectKey) throw new Error("Moving a memory to project scope needs a project.");
  return { scope: "project", projectKey, project };
}

function addRanks(ranks: Map<number, number>, ids: number[]): void {
  for (const [index, id] of ids.entries()) ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + index + 1));
}

function boost(row: MemoryRow, nowMs: number, usageRanking: boolean): number {
  const touched = Math.max(Date.parse(row.updated_at), row.verified_at ? Date.parse(row.verified_at) : 0);
  const ageDays = Math.max(0, (nowMs - touched) / 86_400_000);
  const recency = MAX_RECENCY_BOOST / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
  const assessedActivity = Math.max(
    0,
    row.application_count + row.validated_helpful_count - row.validated_harmful_count,
  );
  const usageShare = Math.log2(1 + assessedActivity) / Math.log2(1 + FULL_USAGE_BOOST_USES);
  const usage = usageRanking ? MAX_USAGE_BOOST * Math.min(1, usageShare) : 0;
  const base =
    1 + PINNED_BOOST * row.pinned + recency + (row.scope === "project" ? PROJECT_BOOST : 0) + usage;
  return usageRanking ? base * usageFactor({ shown: row.shown_count, opened: row.opened_count }) : base;
}

function memoryHit(
  row: MemoryWithProject,
  ranking: { score: number; similarity?: number | null },
): MemoryHit {
  return {
    kind: "memory",
    id: String(row.id),
    revision: row.record_revision,
    title: row.title,
    type: row.type,
    scope: row.scope,
    projectKey: row.project_key,
    projectName: row.project_name,
    preview: clip(row.content, 240),
    pinned: row.pinned === 1,
    updatedAt: row.updated_at,
    useCount: row.use_count,
    shownCount: row.shown_count,
    openedCount: row.opened_count,
    lastUsedAt: row.last_used_at,
    topicKey: row.topic_key,
    score: ranking.score,
    similarity: ranking.similarity ?? null,
    relevance: null,
  };
}

function memoryDetail(row: MemoryWithProject): NonNullable<MemoryDetail["memory"]> {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    scope: row.scope,
    projectName: row.project_name,
    topicKey: row.topic_key,
    pinned: row.pinned === 1,
    source: row.source,
    agentId: row.agent_id,
    provider: row.provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
    shownCount: row.shown_count,
    openedCount: row.opened_count,
    lastUsedAt: row.last_used_at,
    revisionCount: row.revision_count,
    recordRevision: row.record_revision,
  };
}
