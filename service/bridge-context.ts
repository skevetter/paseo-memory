import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  BRIDGE_DEFAULTS,
  type BridgeContextRequest,
  type BridgeContextResult,
  BridgeContextResultSchema,
} from "../shared/bridge";
import { MemoryRefSchema, RecordKindSchema } from "../shared/lifecycle";
import type { RetrievalRequest, RetrievalResult } from "../shared/retrieval";
import type { Access } from "./access";
import { retrievalAudit } from "./audit";
import { BridgeFailure } from "./bridge-errors";
import { historicalBridgeContext } from "./bridge-history";
import type { BridgeSessionRow, BridgeSessions } from "./bridge-sessions";
import { retrieveContext } from "./context";
import type { ContextTokenizer } from "./context-budget";
import { canonicalBody } from "./mutations";
import { sessionVersion } from "./sessions";
import type { MemoryStore } from "./store";
import { sha256 } from "./text";

const SnapshotSchema = z.strictObject({
  currentRevisions: z.array(MemoryRefSchema),
  sessionVersions: z.array(z.strictObject({ id: z.string(), version: z.string() })),
  asOf: z.string().nullable(),
});
interface ContextRow {
  retrieval_id: string;
  session_id: string;
  session_epoch: number;
  lease_version: number;
  context_json: string | null;
  memory_refs: string;
  evidence_refs: string;
  source_snapshot: string;
  policy_revision: number;
  index_generation: number;
  invalidated_at: string | null;
}
interface Options {
  db: Database;
  store: MemoryStore;
  sessions: BridgeSessions;
  now: () => string;
  tokenizers?: ReadonlyMap<string, ContextTokenizer>;
}
interface Flight {
  hash: string;
  controller: AbortController;
  result: Promise<BridgeContextResult>;
}

export class BridgeContexts {
  private readonly pending = new Map<string, Flight>();
  constructor(private readonly options: Options) {}
  private get db(): Database {
    return this.options.db;
  }
  async get(
    header: string | null,
    input: BridgeContextRequest,
    signal: AbortSignal,
  ): Promise<BridgeContextResult> {
    const row = this.options.sessions.scoped(header, input.sessionId, input.leaseVersion, "context");
    const principal = `consumer:${row.consumer_id}`;
    const hash = sha256(canonicalBody(input));
    const previous = this.previous(principal, input.requestId, hash);
    if (previous) return this.current(previous);
    const key = `${principal}:${input.requestId}`;
    const existing = this.pending.get(key);
    if (existing && existing.hash !== hash)
      throw new BridgeFailure("request_conflict", "The pending context request has different content.");
    if (!existing && this.pending.size >= BRIDGE_DEFAULTS.maxCachedContexts)
      throw new BridgeFailure("budget_exhausted", "The context admission limit was reached.", true);
    const flight = existing ?? this.start({ key, hash }, row, input, signal);
    const result = await flight.result;
    this.options.sessions.scoped(header, input.sessionId, input.leaseVersion, "context");
    return this.current(result.retrievalId);
  }
  private start(
    identity: { key: string; hash: string },
    row: BridgeSessionRow,
    input: BridgeContextRequest,
    signal: AbortSignal,
  ): Flight {
    const { key, hash } = identity;
    const controller = new AbortController();
    const flight: Flight = {
      hash,
      controller,
      result: this.collect(row, input, AbortSignal.any([signal, controller.signal])).finally(() => {
        if (this.pending.get(key) === flight) this.pending.delete(key);
      }),
    };
    this.pending.set(key, flight);
    return flight;
  }
  private previous(principal: string, requestId: string, hash: string): string | null {
    const row = this.db
      .query<{ body_hash: string; result_json: string }, [string, string]>(
        "SELECT body_hash,result_json FROM bridge_requests WHERE principal_id=? AND endpoint='context' AND request_id=?",
      )
      .get(principal, requestId);
    if (!row) return null;
    if (row.body_hash !== hash)
      throw new BridgeFailure(
        "request_conflict",
        "The context request identifier was reused with changed content.",
      );
    return z.strictObject({ retrievalId: z.string().min(1) }).parse(JSON.parse(row.result_json)).retrievalId;
  }
  private async collect(
    row: BridgeSessionRow,
    input: BridgeContextRequest,
    signal: AbortSignal,
  ): Promise<BridgeContextResult> {
    const { store, sessions } = this.options;
    const access = this.contextAccess(row, input);
    const request = this.retrievalRequest(input);
    const tokenizer = input.budget.tokenizerId
      ? this.options.tokenizers?.get(input.budget.tokenizerId)
      : undefined;
    if (input.asOf) {
      const policy = store.retrievalPolicies.resolve(request);
      const result = historicalBridgeContext({
        db: this.db,
        store,
        access,
        request: { ...input, asOf: input.asOf },
        policy,
        tokenizer,
      });
      this.record(row, input, result, new Map());
      return bridgeResult(result);
    }
    let recorded = false;
    const result = await retrieveContext({
      store,
      access,
      project: null,
      query: input.query,
      request,
      includeSessions: false,
      signal,
      tokenizer,
      authorize: () => {
        sessions.live(row.session_id, input.leaseVersion, "context");
      },
      complete: (selected, _scores, _policy, versions) => {
        this.record(row, input, selected, versions);
        recorded = true;
      },
    });
    if (!recorded)
      throw new BridgeFailure(
        "context_invalidated",
        "The context request was cancelled before durable disclosure.",
      );
    return bridgeResult(result);
  }
  private contextAccess(row: BridgeSessionRow, input: BridgeContextRequest): Access {
    const full = this.options.sessions.access(row);
    if (input.namespaceFilter.some((namespace) => !full.allows("read", namespace)))
      throw new BridgeFailure("scope_denied", "Context filters cannot widen the registered read grant.");
    return this.options.sessions.access(row, input.namespaceFilter);
  }
  private retrievalRequest(input: BridgeContextRequest): RetrievalRequest {
    const kinds = z.array(RecordKindSchema).safeParse([...new Set(input.recordKinds)]);
    if (!kinds.success)
      throw new BridgeFailure(
        "unsupported_version",
        "A requested record kind is not supported by this server.",
      );
    return {
      budget: {
        maxTokens: input.budget.maxTokens,
        maxChars: input.budget.maxChars,
        maxLatencyMs: input.budget.maxLatencyMs,
        ...(input.namespaceFilter.length ? {} : { maxCandidates: 0 }),
      },
      recordKinds: kinds.data,
      tokenizerId: input.budget.tokenizerId,
    };
  }
  private record(
    session: BridgeSessionRow,
    input: BridgeContextRequest,
    result: RetrievalResult,
    versions: ReadonlyMap<string, string>,
  ): void {
    this.db
      .transaction(() => {
        const current = this.options.sessions.live(session.session_id, input.leaseVersion, "context");
        if (
          result.policyRevision !== this.options.store.retrievalPolicies.revision ||
          result.indexGeneration !== this.options.store.retrievalGeneration
        )
          throw new BridgeFailure(
            "context_invalidated",
            "Retrieval authority changed before context commitment.",
          );
        const access = this.contextAccess(current, input);
        const snapshot = this.snapshot(access, result, versions, input.asOf ?? null);
        const response = bridgeResult(result);
        this.db
          .query(`INSERT INTO bridge_contexts(retrieval_id,session_id,session_epoch,lease_version,context_json,
        memory_refs,evidence_refs,source_snapshot,policy_revision,index_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            result.retrievalId,
            session.session_id,
            session.session_epoch,
            input.leaseVersion,
            JSON.stringify(response),
            JSON.stringify(result.memoryRefs),
            JSON.stringify(result.evidenceRefs),
            JSON.stringify(snapshot),
            result.policyRevision,
            result.indexGeneration,
            this.options.now(),
          );
        this.db
          .query("UPDATE bridge_sessions SET context_retrieval_id=? WHERE session_id=?")
          .run(result.retrievalId, session.session_id);
        this.options.store.audit.record(this.options.sessions.nonce(session), {
          kind: "context",
          memories: result.memoryRefs.map((ref) => ref.id),
          sessions: result.sessionIds,
          chars: result.usage.chars,
          budget: input.budget.maxChars,
          retrieval: retrievalAudit(result),
        });
        this.db
          .query(
            "INSERT INTO bridge_requests(principal_id,endpoint,request_id,body_hash,result_json,created_at) VALUES(?,'context',?,?,?,?)",
          )
          .run(
            `consumer:${session.consumer_id}`,
            input.requestId,
            sha256(canonicalBody(input)),
            JSON.stringify({ retrievalId: result.retrievalId }),
            this.options.now(),
          );
        this.prune();
      })
      .immediate();
  }
  private snapshot(
    access: Access,
    result: RetrievalResult,
    versions: ReadonlyMap<string, string>,
    asOf: string | null,
  ): z.infer<typeof SnapshotSchema> {
    const currentRevisions = result.memoryRefs.map((ref) => {
      const current = this.db
        .query<
          {
            id: number;
            record_revision: number;
            scope: string;
            project_key: string | null;
            bot_id: string | null;
          },
          [number]
        >("SELECT id,record_revision,scope,project_key,bot_id FROM memories WHERE id=?")
        .get(ref.id);
      const selected = asOf
        ? this.options.store.historical(access, ref.id, asOf)
        : this.options.store.getVisible(access, [ref.id])[0];
      if (!current || !selected || selected.record_revision !== ref.revision) this.invalid();
      return { id: current.id, revision: current.record_revision };
    });
    const sessionVersions = result.sessionIds.map((id) => {
      const version = versions.get(id);
      const current = this.options.store.visibleSessions(access, [id])[0];
      if (!version || !current || sessionVersion(current) !== version) this.invalid();
      return { id, version };
    });
    if (
      this.options.store.provenance.getVisible(access, result.evidenceRefs).length !==
      result.evidenceRefs.length
    )
      this.invalid();
    return { currentRevisions, sessionVersions, asOf };
  }
  current(id: string): BridgeContextResult {
    const row = this.db
      .query<ContextRow, [string]>("SELECT * FROM bridge_contexts WHERE retrieval_id=?")
      .get(id);
    if (!row || row.invalidated_at || !row.context_json) this.invalid();
    const result = BridgeContextResultSchema.parse(JSON.parse(row.context_json));
    const session = this.options.sessions.row(row.session_id);
    if (
      session.state === "revoked" ||
      row.session_epoch !== session.session_epoch ||
      row.lease_version !== session.lease_version ||
      row.policy_revision !== this.options.store.retrievalPolicies.revision ||
      row.index_generation !== this.options.store.retrievalGeneration
    )
      this.invalidate(id);
    const snapshot = SnapshotSchema.parse(JSON.parse(row.source_snapshot));
    this.assertSnapshot(this.options.sessions.access(session), result, snapshot);
    return result;
  }
  private assertSnapshot(
    access: Access,
    result: BridgeContextResult,
    snapshot: z.infer<typeof SnapshotSchema>,
  ): void {
    if (snapshot.currentRevisions.length !== result.memoryRefs.length) this.invalid();
    this.assertCurrentRevisions(snapshot.currentRevisions);
    for (const ref of result.memoryRefs) {
      const row = snapshot.asOf
        ? this.options.store.historical(access, ref.id, snapshot.asOf)
        : this.options.store.getVisible(access, [ref.id])[0];
      if (!row || row.record_revision !== ref.revision) this.invalid();
    }
    this.assertSessionVersions(access, snapshot.sessionVersions);
    if (
      this.options.store.provenance.getVisible(access, result.evidenceRefs).length !==
      result.evidenceRefs.length
    )
      this.invalid();
  }
  private assertSessionVersions(
    access: Access,
    refs: z.infer<typeof SnapshotSchema>["sessionVersions"],
  ): void {
    for (const ref of refs) {
      const row = this.options.store.visibleSessions(access, [ref.id])[0];
      if (!row || sessionVersion(row) !== ref.version) this.invalid();
    }
  }
  private assertCurrentRevisions(refs: z.infer<typeof MemoryRefSchema>[]): void {
    for (const ref of refs) {
      const current = this.db
        .query<{ record_revision: number }, [number]>("SELECT record_revision FROM memories WHERE id=?")
        .get(ref.id);
      if (current?.record_revision !== ref.revision) this.invalid();
    }
  }
  assertIssued(id: string, session: BridgeSessionRow, leaseVersion: number): void {
    const row = this.db
      .query<ContextRow, [string]>("SELECT * FROM bridge_contexts WHERE retrieval_id=?")
      .get(id);
    if (
      !row ||
      row.session_id !== session.session_id ||
      row.session_epoch !== session.session_epoch ||
      row.lease_version !== leaseVersion
    )
      this.invalid();
  }
  private prune(): void {
    const expired = this.db
      .query<{ retrieval_id: string }, [number]>(`SELECT retrieval_id FROM bridge_contexts
      WHERE context_json IS NOT NULL ORDER BY created_at DESC,retrieval_id DESC LIMIT -1 OFFSET ?`)
      .all(BRIDGE_DEFAULTS.maxCachedContexts);
    for (const row of expired) this.clear(row.retrieval_id);
  }
  private clear(id: string): void {
    this.db
      .query(`UPDATE bridge_contexts SET context_json=NULL,memory_refs='[]',evidence_refs='[]',source_snapshot='null',
      invalidated_at=coalesce(invalidated_at,?) WHERE retrieval_id=?`)
      .run(this.options.now(), id);
  }
  private invalidate(id: string): never {
    this.clear(id);
    return this.invalid();
  }
  private invalid(): never {
    throw new BridgeFailure(
      "context_invalidated",
      "Prepared context is no longer authorized; request fresh context with a new request identifier.",
    );
  }
  cancelPending(): void {
    for (const flight of this.pending.values()) flight.controller.abort("bridge authority invalidated");
    this.pending.clear();
  }
  close(): void {
    this.cancelPending();
  }
}

function bridgeResult(result: RetrievalResult): BridgeContextResult {
  return BridgeContextResultSchema.parse({
    protocolVersion: 1,
    retrievalId: result.retrievalId,
    contextText: result.contextText,
    memoryRefs: result.memoryRefs,
    evidenceRefs: result.evidenceRefs,
    usage: {
      tokenCount: result.usage.tokenCount,
      tokenCountIsEstimate: result.usage.tokenCountIsEstimate,
      estimator: result.usage.estimator,
      chars: result.usage.chars,
      latencyMs: result.usage.latencyMs,
    },
    truncated: result.truncated,
    omittedCount: result.omittedCount,
    fallbackReason: result.fallbackReason,
    policyRevision: result.policyRevision,
    indexGeneration: result.indexGeneration,
  });
}
