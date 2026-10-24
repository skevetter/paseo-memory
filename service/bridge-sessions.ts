import type { Database } from "bun:sqlite";
import { createHmac, randomUUID } from "node:crypto";
import {
  BRIDGE_DEFAULTS,
  type BridgeConsumerPolicy,
  BridgeConsumerPolicySchema,
  type BridgeIdentity,
  BridgeIdentitySchema,
  type BridgeOrigin,
  BridgeOriginSchema,
  type BridgeOwnerStatus,
  type BridgeOwnership,
  BridgeOwnershipSchema,
  type BridgeRotation,
  type BridgeRotationResult,
  BridgeRotationResultSchema,
  type BridgeSessionRequest,
  type BridgeSessionResult,
  BridgeSessionResultSchema,
  type BridgeSettings,
  BridgeSettingsSchema,
  type BridgeToolClaim,
} from "../shared/bridge";
import { type MemoryNamespace, namespaceKey } from "../shared/namespaces";
import { Access } from "./access";
import { BridgeFailure } from "./bridge-errors";
import type { Caller } from "./mcp";
import { canonicalBody, type MutationPrincipal } from "./mutations";
import { sha256 } from "./text";

type FunctionName = BridgeConsumerPolicy["functions"][number];
type Register = Extract<BridgeSessionRequest, { action: "register" }>;
type Bind = Extract<BridgeSessionRequest, { action: "bind" }>;
interface ConsumerRow {
  consumer_id: string;
  credential_hash: string;
  credential_version: number;
  enabled: number;
  read_grants: string;
  write_grants: string;
  allowed_functions: string;
  allowed_mutations: string;
  allowed_mutation_purposes: string;
}
export interface BridgeSessionRow {
  session_id: string;
  consumer_id: string;
  intended_agent_id: string;
  actual_agent_id: string | null;
  session_epoch: number;
  origin_json: string;
  expected_identity_json: string;
  ownership_json: string;
  grants_json: string;
  state: "pending" | "bound" | "released" | "expired" | "revoked";
  lease_version: number;
  expires_at: string;
  bootstrap_hash: string | null;
  bootstrap_expires_at: string | null;
  bootstrap_consumed_at: string | null;
  create_seen_at: string | null;
  create_seen_lease_version: number | null;
  create_seen_config_hash: string | null;
  context_retrieval_id: string | null;
  tool_token_hash: string | null;
  tool_activated_epoch: number | null;
  tool_revoked_at: string | null;
}
export interface BridgeLeaseRow {
  session_id: string;
  lease_version: number;
  session_epoch: number;
  origin_json: string;
  grants_json: string;
  ownership_json: string;
  bound_at: string | null;
  expires_at: string;
  terminal_at: string | null;
  terminal_deadline: string | null;
  terminal_reason: string | null;
  terminal_window_seconds: number;
  revoked_at: string | null;
}
interface SessionOptions {
  db: Database;
  secret: string;
  now: () => number;
  assertContext: (retrievalId: string) => void;
  assertAgent: (agentId: string, nonce: string) => void;
  managedChanged: () => void;
  recordIdentity: (session: BridgeSessionRow, tools: boolean) => void;
}

export class BridgeSessions {
  private settings: BridgeSettings = BridgeSettingsSchema.parse({});
  private closed = false;
  constructor(private readonly options: SessionOptions) {}
  private get db(): Database {
    return this.options.db;
  }
  private time(): string {
    return new Date(this.options.now()).toISOString();
  }
  private derive(label: string): string {
    return createHmac("sha256", this.options.secret)
      .update(`paseo-memory/bridge/v1/${label}`)
      .digest("base64url");
  }
  private controllerToken(id: string, version: number): string {
    return `pmbc1_${this.derive(`controller/${id}/${version}`)}`;
  }
  private sessionToken(row: BridgeSessionRow): string {
    return `pmbs1_${this.derive(`session/${row.session_id}/${row.lease_version}`)}`;
  }
  private bootstrap(row: BridgeSessionRow): string {
    return `pmbr1_${this.derive(`bootstrap/${row.session_id}`)}`;
  }
  nonce(row: BridgeSessionRow): string {
    return `bridge:${row.session_id}:${row.session_epoch}`;
  }
  origin(row: BridgeSessionRow): BridgeOrigin {
    return BridgeOriginSchema.parse(JSON.parse(row.origin_json));
  }
  ownership(row: BridgeSessionRow): BridgeOwnership {
    return BridgeOwnershipSchema.parse(JSON.parse(row.ownership_json));
  }
  identity(row: BridgeSessionRow): BridgeIdentity {
    return BridgeIdentitySchema.parse(JSON.parse(row.expected_identity_json));
  }
  private consumerPolicy(row: ConsumerRow): BridgeConsumerPolicy {
    return BridgeConsumerPolicySchema.parse({
      id: row.consumer_id,
      readNamespaces: JSON.parse(row.read_grants),
      writeNamespaces: JSON.parse(row.write_grants),
      functions: JSON.parse(row.allowed_functions),
      mutations: JSON.parse(row.allowed_mutations),
      mutationPurposes: JSON.parse(row.allowed_mutation_purposes),
    });
  }
  private grant(row: BridgeSessionRow): BridgeConsumerPolicy {
    return BridgeConsumerPolicySchema.parse(JSON.parse(row.grants_json));
  }
  configure(input: BridgeSettings): void {
    const settings = BridgeSettingsSchema.parse(input);
    if (new Set(settings.consumers.map((policy) => policy.id)).size !== settings.consumers.length)
      throw new BridgeFailure("unsupported_version", "Consumer identifiers must be unique.");
    this.db
      .transaction(() => {
        const current = this.db.query<ConsumerRow, []>("SELECT * FROM bridge_consumers").all();
        for (const row of current) this.reconcileConsumer(row, settings);
        for (const policy of settings.consumers) this.saveConsumer(policy, settings.enabled);
      })
      .immediate();
    this.settings = settings;
    this.options.managedChanged();
  }
  private reconcileConsumer(row: ConsumerRow, settings: BridgeSettings): void {
    const policy = settings.consumers.find((candidate) => candidate.id === row.consumer_id);
    if (!settings.enabled || !policy) this.disableConsumer(row.consumer_id);
    else if (canonicalBody(this.consumerPolicy(row)) !== canonicalBody(policy))
      this.revokeConsumer(row.consumer_id);
  }
  private saveConsumer(policy: BridgeConsumerPolicy, enabled: boolean): void {
    const previous = this.db
      .query<ConsumerRow, [string]>("SELECT * FROM bridge_consumers WHERE consumer_id=?")
      .get(policy.id);
    const version = previous ? previous.credential_version + (enabled && !previous.enabled ? 1 : 0) : 1;
    this.db
      .query(`INSERT INTO bridge_consumers
      (consumer_id,credential_hash,credential_version,enabled,read_grants,write_grants,allowed_functions,
       allowed_mutations,allowed_mutation_purposes,created_at,updated_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(consumer_id) DO UPDATE SET
      credential_hash=excluded.credential_hash,credential_version=excluded.credential_version,
      enabled=excluded.enabled,read_grants=excluded.read_grants,
      write_grants=excluded.write_grants,allowed_functions=excluded.allowed_functions,
      allowed_mutations=excluded.allowed_mutations,allowed_mutation_purposes=excluded.allowed_mutation_purposes,
      updated_at=excluded.updated_at,revoked_at=NULL`)
      .run(
        policy.id,
        sha256(this.controllerToken(policy.id, version)),
        version,
        enabled ? 1 : 0,
        JSON.stringify(policy.readNamespaces),
        JSON.stringify(policy.writeNamespaces),
        JSON.stringify(policy.functions),
        JSON.stringify(policy.mutations),
        JSON.stringify(policy.mutationPurposes),
        this.time(),
        this.time(),
      );
  }
  private disableConsumer(id: string): void {
    this.revokeConsumer(id);
    this.db
      .query("UPDATE bridge_consumers SET enabled=0,revoked_at=? WHERE consumer_id=?")
      .run(this.time(), id);
  }
  private revokeConsumer(id: string): void {
    this.db
      .query(`UPDATE bridge_sessions SET state='revoked',tool_revoked_at=?,updated_at=?
      WHERE consumer_id=? AND state IN ('pending','bound')`)
      .run(this.time(), this.time(), id);
    this.db
      .query(`UPDATE bridge_leases SET revoked_at=? WHERE session_id IN
      (SELECT session_id FROM bridge_sessions WHERE consumer_id=?) AND revoked_at IS NULL`)
      .run(this.time(), id);
  }
  credentials(): { consumerId: string; token: string }[] {
    if (!this.settings.enabled || this.closed) return [];
    return this.db
      .query<ConsumerRow, []>("SELECT * FROM bridge_consumers WHERE enabled=1 ORDER BY consumer_id")
      .all()
      .map((row) => ({
        consumerId: row.consumer_id,
        token: this.controllerToken(row.consumer_id, row.credential_version),
      }));
  }
  contextAllowed(consumerId: string): boolean {
    const policy = this.consumerPolicy(this.consumer(consumerId));
    return policy.functions.includes("context") && policy.readNamespaces.length > 0;
  }
  ownerStatus(): BridgeOwnerStatus {
    return {
      enabled: this.settings.enabled && !this.closed,
      consumers: this.db
        .query<ConsumerRow, []>("SELECT * FROM bridge_consumers ORDER BY consumer_id")
        .all()
        .map((row) => ({
          policy: this.consumerPolicy(row),
          enabled: Boolean(row.enabled),
          credentialVersion: row.credential_version,
        })),
      native: {
        createObservation: "provider_cwd_only",
        credentialRollover: "unsupported_new_execution_required",
        pairedValidation: "not_qualified",
        trustedEvidenceResolver: "unavailable",
      },
    };
  }
  rotate(input: BridgeRotation): BridgeRotationResult {
    return this.db
      .transaction(() => {
        const hash = sha256(canonicalBody(input));
        const prior = this.db
          .query<{ body_hash: string; result_json: string }, [string]>(
            "SELECT body_hash,result_json FROM bridge_requests WHERE principal_id='owner' AND endpoint='rotate' AND request_id=?",
          )
          .get(input.requestId);
        if (prior) {
          if (prior.body_hash !== hash)
            throw new BridgeFailure("request_conflict", "The rotation request body changed.");
          return BridgeRotationResultSchema.parse(JSON.parse(prior.result_json));
        }
        const row = this.consumer(input.consumerId);
        if (row.credential_version !== input.expectedVersion)
          throw new BridgeFailure("revision_conflict", "The controller credential version changed.");
        const version = row.credential_version + 1;
        if (!Number.isSafeInteger(version))
          throw new BridgeFailure("unavailable", "The credential version is exhausted.");
        this.revokeConsumer(row.consumer_id);
        this.db
          .query(
            "UPDATE bridge_consumers SET credential_version=?,credential_hash=?,updated_at=? WHERE consumer_id=?",
          )
          .run(version, sha256(this.controllerToken(row.consumer_id, version)), this.time(), row.consumer_id);
        const result = { consumerId: row.consumer_id, credentialVersion: version };
        this.db
          .query(
            "INSERT INTO bridge_requests(principal_id,endpoint,request_id,body_hash,result_json,created_at) VALUES('owner','rotate',?,?,?,?)",
          )
          .run(input.requestId, hash, JSON.stringify(result), this.time());
        return result;
      })
      .immediate();
  }
  managedAgentIds(): string[] {
    return this.db
      .query<{ id: string }, []>(`SELECT intended_agent_id AS id FROM bridge_sessions
      UNION SELECT actual_agent_id AS id FROM bridge_sessions WHERE actual_agent_id IS NOT NULL ORDER BY id`)
      .all()
      .map((row) => row.id);
  }
  isManaged(agentId: string): boolean {
    return isManagedBridgeAgent(this.db, agentId);
  }
  available(): void {
    if (this.closed || !this.settings.enabled)
      throw new BridgeFailure("unavailable", "The owner has not enabled Bridge v1.");
  }
  controller(header: string | null, feature?: FunctionName): string {
    this.available();
    const token = bearer(header);
    const row = this.db
      .query<ConsumerRow, [string]>("SELECT * FROM bridge_consumers WHERE credential_hash=? AND enabled=1")
      .get(sha256(token));
    if (!row) throw new BridgeFailure("unauthorized", "A current controller credential is required.");
    if (feature && !this.consumerPolicy(row).functions.includes(feature)) this.denied();
    return row.consumer_id;
  }
  private consumer(id: string): ConsumerRow {
    this.available();
    const row = this.db
      .query<ConsumerRow, [string]>("SELECT * FROM bridge_consumers WHERE consumer_id=? AND enabled=1")
      .get(id);
    if (!row) throw new BridgeFailure("scope_denied", "The consumer grant was revoked.");
    return row;
  }
  row(id: string): BridgeSessionRow {
    const row = this.db
      .query<BridgeSessionRow, [string]>("SELECT * FROM bridge_sessions WHERE session_id=?")
      .get(id);
    if (!row) throw new BridgeFailure("scope_denied", "The session is unavailable.");
    return row;
  }
  live(id: string, version: number, feature?: FunctionName): BridgeSessionRow {
    let row = this.row(id);
    this.consumer(row.consumer_id);
    this.options.assertAgent(row.actual_agent_id ?? row.intended_agent_id, this.nonce(row));
    if (
      (row.state === "pending" || row.state === "bound") &&
      Date.parse(row.expires_at) <= this.options.now()
    ) {
      this.end(row, "expired", row.expires_at);
      row = this.row(id);
    }
    if (row.state !== "pending" && row.state !== "bound")
      throw new BridgeFailure("lease_expired", "This lease no longer grants active access.");
    if (row.lease_version !== version)
      throw new BridgeFailure("lease_conflict", "The authority fence changed.");
    if (feature && !this.grant(row).functions.includes(feature)) this.denied();
    return row;
  }
  scoped(header: string | null, id: string, version: number, feature: FunctionName): BridgeSessionRow {
    const row = this.db
      .query<BridgeSessionRow, [string]>("SELECT * FROM bridge_sessions WHERE session_token_hash=?")
      .get(sha256(bearer(header)));
    if (!row || row.session_id !== id)
      throw new BridgeFailure("unauthorized", "A matching scoped session credential is required.");
    return this.live(id, version, feature);
  }
  access(row: BridgeSessionRow, filter?: readonly MemoryNamespace[]): Access {
    const policy = this.grant(row);
    const requested = filter && new Set(filter.map(namespaceKey));
    const narrow = (namespaces: MemoryNamespace[]) =>
      namespaces.filter((ns) => !requested || requested.has(namespaceKey(ns)));
    return Access.scoped({
      read: narrow(policy.readNamespaces),
      write: narrow(policy.writeNamespaces),
      delete: narrow(policy.writeNamespaces),
      merge: narrow(policy.writeNamespaces),
      restore: narrow(policy.writeNamespaces),
    });
  }
  private denied(): never {
    throw new BridgeFailure("scope_denied", "The registered grant does not authorize this operation.");
  }
  request(consumerId: string, input: BridgeSessionRequest): BridgeSessionResult {
    if (!this.consumerPolicy(this.consumer(consumerId)).functions.includes("sessions")) this.denied();
    const result = this.db
      .transaction(() => {
        const previous = this.receipt(consumerId, input);
        if (previous) return previous;
        const value =
          input.action === "register" ? this.register(consumerId, input) : this.change(consumerId, input);
        this.db
          .query(
            "INSERT INTO bridge_requests(principal_id,endpoint,request_id,body_hash,result_json,created_at) VALUES(?,'sessions',?,?,?,?)",
          )
          .run(
            `consumer:${consumerId}`,
            input.requestId,
            sha256(canonicalBody(input)),
            JSON.stringify(value),
            this.time(),
          );
        return value;
      })
      .immediate();
    this.options.managedChanged();
    return result;
  }
  private receipt(consumerId: string, input: BridgeSessionRequest): BridgeSessionResult | null {
    const prior = this.db
      .query<{ body_hash: string; result_json: string }, [string, string]>(
        "SELECT body_hash,result_json FROM bridge_requests WHERE principal_id=? AND endpoint='sessions' AND request_id=?",
      )
      .get(`consumer:${consumerId}`, input.requestId);
    if (!prior) return null;
    if (prior.body_hash !== sha256(canonicalBody(input)))
      throw new BridgeFailure("request_conflict", "The request identifier was reused with changed content.");
    return BridgeSessionResultSchema.parse(JSON.parse(prior.result_json));
  }
  private register(consumerId: string, input: Register): BridgeSessionResult {
    const policy = this.consumerPolicy(this.consumer(consumerId));
    if (!policy.functions.includes("sessions")) this.denied();
    const granted = requestedPolicy(policy, input.requestedNamespaces);
    const origin = BridgeOriginSchema.parse({
      botId: input.botId,
      runId: input.runId,
      cycleId: input.cycleId,
      attemptId: input.attemptId,
      executionId: input.executionId,
      sessionEpoch: input.sessionEpoch,
      agentId: input.agentId,
      providerTurnId: input.providerTurnId,
      purpose: input.purpose,
    });
    const existing = this.db
      .query<BridgeSessionRow, [string, string]>(
        "SELECT * FROM bridge_sessions WHERE consumer_id=? AND execution_id=?",
      )
      .get(consumerId, input.executionId);
    if (existing) return this.existingRegistration(existing, input, origin, granted);
    if (this.isManaged(input.agentId))
      throw new BridgeFailure(
        "lease_conflict",
        "This agent identity is already managed; use a new execution and fresh agent identity.",
      );
    this.expirePending();
    const pending =
      this.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM bridge_sessions WHERE state='pending'")
        .get()?.count ?? 0;
    if (pending >= BRIDGE_DEFAULTS.maxPendingSessions)
      throw new BridgeFailure("budget_exhausted", "The pending-session limit was reached.", true);
    const sessionId = randomUUID();
    const expires = new Date(this.options.now() + this.settings.leaseSeconds * 1000).toISOString();
    const bootstrap = `pmbr1_${this.derive(`bootstrap/${sessionId}`)}`;
    this.options.assertAgent(input.agentId, `bridge:${sessionId}:${input.sessionEpoch}`);
    this.insertSession({ sessionId, consumerId, input, origin, granted, expires, bootstrap });
    const row = this.row(sessionId);
    this.insertLease(row, null);
    this.options.recordIdentity(row, false);
    return this.result(row, true);
  }
  private existingRegistration(
    row: BridgeSessionRow,
    input: Register,
    origin: BridgeOrigin,
    granted: BridgeConsumerPolicy,
  ): BridgeSessionResult {
    if (
      canonicalBody(this.origin(row)) !== canonicalBody(origin) ||
      canonicalBody(this.identity(row)) !== canonicalBody(input.expectedIdentity) ||
      canonicalBody(this.grant(row)) !== canonicalBody(granted) ||
      canonicalBody(this.ownership(row)) !== canonicalBody(input.ownership)
    )
      throw new BridgeFailure(
        "request_conflict",
        "The execution identity already has different registered semantics.",
      );
    const live = this.live(row.session_id, row.lease_version, "sessions");
    return this.result(live, live.state === "pending");
  }
  private insertSession(value: {
    sessionId: string;
    consumerId: string;
    input: Register;
    origin: BridgeOrigin;
    granted: BridgeConsumerPolicy;
    expires: string;
    bootstrap: string;
  }): void {
    const { sessionId, consumerId, input, origin, granted, expires, bootstrap } = value;
    const token = `pmbs1_${this.derive(`session/${sessionId}/1`)}`;
    this.db
      .query(`INSERT INTO bridge_sessions
      (session_id,consumer_id,bot_id,run_id,cycle_id,attempt_id,execution_id,intended_agent_id,session_epoch,
       origin_json,expected_identity_json,ownership_json,grants_json,state,lease_version,expires_at,
       session_token_hash,bootstrap_hash,bootstrap_expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,?,?,?,?)`)
      .run(
        sessionId,
        consumerId,
        input.botId,
        input.runId,
        input.cycleId,
        input.attemptId,
        input.executionId,
        input.agentId,
        input.sessionEpoch,
        JSON.stringify(origin),
        JSON.stringify(input.expectedIdentity),
        JSON.stringify(input.ownership),
        JSON.stringify(granted),
        expires,
        sha256(token),
        sha256(bootstrap),
        new Date(this.options.now() + this.settings.bootstrapSeconds * 1000).toISOString(),
        this.time(),
        this.time(),
      );
  }
  private insertLease(row: BridgeSessionRow, boundAt: string | null): void {
    this.db
      .query(`INSERT INTO bridge_leases(session_id,lease_version,session_epoch,origin_json,grants_json,
      ownership_json,bound_at,expires_at,terminal_window_seconds) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(
        row.session_id,
        row.lease_version,
        row.session_epoch,
        row.origin_json,
        row.grants_json,
        row.ownership_json,
        boundAt,
        row.expires_at,
        this.settings.terminalSeconds,
      );
  }
  private change(consumerId: string, input: Exclude<BridgeSessionRequest, Register>): BridgeSessionResult {
    const row = this.live(input.sessionId, input.leaseVersion, "sessions");
    if (row.consumer_id !== consumerId) this.denied();
    if (input.action === "bind") return this.bind(row, input);
    if (input.action === "release") {
      this.end(row, "released", this.time());
      return this.result(this.row(row.session_id));
    }
    const expires = new Date(this.options.now() + this.settings.leaseSeconds * 1000).toISOString();
    this.db
      .query("UPDATE bridge_sessions SET expires_at=?,updated_at=? WHERE session_id=?")
      .run(expires, this.time(), row.session_id);
    this.db
      .query(
        "UPDATE bridge_leases SET expires_at=? WHERE session_id=? AND lease_version=? AND terminal_at IS NULL",
      )
      .run(expires, row.session_id, row.lease_version);
    return this.result(this.row(row.session_id));
  }
  private bind(row: BridgeSessionRow, input: Bind): BridgeSessionResult {
    if (
      input.actualAgentId !== row.intended_agent_id ||
      canonicalBody(input.observedIdentity) !== canonicalBody(this.identity(row))
    )
      throw new BridgeFailure("scope_denied", "The observed native identity does not match registration.");
    if (input.sessionEpoch !== row.session_epoch)
      throw new BridgeFailure(
        "unsupported_version",
        "Native credential rollover is not qualified on this SDK combination; use a new execution with a fresh agent.",
      );
    if (row.state === "bound") return this.result(row);
    this.assertCreateSeen(row, input.bootstrapRef);
    this.assertPreparedContexts(row);
    const version = row.lease_version + 1;
    const token = `pmbs1_${this.derive(`session/${row.session_id}/${version}`)}`;
    this.db
      .query(`UPDATE bridge_sessions SET actual_agent_id=?,state='bound',lease_version=?,session_token_hash=?,
      bootstrap_consumed_at=?,tool_activated_epoch=session_epoch,updated_at=? WHERE session_id=?`)
      .run(input.actualAgentId, version, sha256(token), this.time(), this.time(), row.session_id);
    const bound = this.row(row.session_id);
    this.insertLease(bound, this.time());
    this.db
      .query("UPDATE bridge_contexts SET lease_version=? WHERE session_id=? AND lease_version=?")
      .run(version, row.session_id, row.lease_version);
    return this.result(bound);
  }
  private assertCreateSeen(row: BridgeSessionRow, bootstrapRef: string | undefined): void {
    if (
      !bootstrapRef ||
      sha256(bootstrapRef) !== row.bootstrap_hash ||
      row.bootstrap_consumed_at ||
      !row.bootstrap_expires_at ||
      Date.parse(row.bootstrap_expires_at) <= this.options.now()
    )
      throw new BridgeFailure(
        "lease_conflict",
        "The one-use bootstrap reference is absent, expired or consumed.",
      );
    if (!row.create_seen_at || row.create_seen_lease_version !== row.lease_version || !row.tool_token_hash)
      throw new BridgeFailure("lease_conflict", "Memory did not observe native creation under this lease.");
  }
  private result(row: BridgeSessionRow, includeBootstrap = false): BridgeSessionResult {
    const policy = this.grant(row);
    const unique = new Map(
      [...policy.readNamespaces, ...policy.writeNamespaces].map((ns) => [namespaceKey(ns), ns]),
    );
    return {
      protocolVersion: 1,
      sessionId: row.session_id,
      leaseVersion: row.lease_version,
      expiresAt: row.expires_at,
      grantedNamespaces: [...unique.values()],
      ownership: this.ownership(row),
      sessionToken: this.sessionToken(row),
      ...(includeBootstrap ? { bootstrapRef: this.bootstrap(row) } : {}),
    };
  }
  private end(row: BridgeSessionRow, state: "expired" | "released", at: string): void {
    const advance = state === "released" ? 1 : 0;
    if (!Number.isSafeInteger(row.lease_version + advance))
      throw new BridgeFailure("unavailable", "The authority fence is exhausted.");
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE bridge_sessions SET state=?,lease_version=lease_version+?,tool_revoked_at=?,updated_at=? WHERE session_id=? AND state IN ('pending','bound')",
          )
          .run(state, advance, at, this.time(), row.session_id);
        const lease = this.lease(row.session_id, row.lease_version);
        if (lease.terminal_at === null)
          this.db
            .query(`UPDATE bridge_leases SET terminal_at=?,terminal_deadline=?,terminal_reason=?
        WHERE session_id=? AND lease_version=? AND terminal_at IS NULL`)
            .run(
              at,
              new Date(
                Date.parse(at) +
                  Math.min(lease.terminal_window_seconds, this.settings.terminalSeconds) * 1000,
              ).toISOString(),
              state,
              row.session_id,
              row.lease_version,
            );
      })
      .immediate();
  }
  lease(id: string, version: number): BridgeLeaseRow {
    const row = this.db
      .query<BridgeLeaseRow, [string, number]>(
        "SELECT * FROM bridge_leases WHERE session_id=? AND lease_version=?",
      )
      .get(id, version);
    if (!row) throw new BridgeFailure("lease_conflict", "The originating lease is unavailable.");
    return row;
  }
  terminal(
    consumerId: string,
    id: string,
    version: number,
    feature: "events" | "feedback",
  ): { session: BridgeSessionRow; lease: BridgeLeaseRow } {
    let session = this.row(id);
    const consumer = this.consumer(consumerId);
    if (session.consumer_id !== consumerId || !this.consumerPolicy(consumer).functions.includes(feature))
      this.denied();
    this.options.assertAgent(session.actual_agent_id ?? session.intended_agent_id, this.nonce(session));
    if (
      (session.state === "pending" || session.state === "bound") &&
      Date.parse(session.expires_at) <= this.options.now()
    ) {
      this.end(session, "expired", session.expires_at);
      session = this.row(id);
    }
    if (session.state !== "released" && session.state !== "expired") this.denied();
    const lease = this.lease(id, version);
    if (
      !lease.bound_at ||
      lease.revoked_at ||
      !lease.terminal_deadline ||
      Date.parse(lease.terminal_deadline) <= this.options.now()
    )
      throw new BridgeFailure("lease_expired", "The fixed terminal-delivery window is closed.");
    return { session, lease };
  }
  private assertPreparedContexts(row: BridgeSessionRow): void {
    // The public bind does not identify a selected fragment. Certify every issued fragment, not merely the latest one.
    const contexts = this.db
      .query<{ retrieval_id: string }, [string, number, number]>(
        "SELECT retrieval_id FROM bridge_contexts WHERE session_id=? AND session_epoch=? ORDER BY created_at,retrieval_id LIMIT ?",
      )
      .all(row.session_id, row.session_epoch, BRIDGE_DEFAULTS.maxCachedContexts + 1);
    if (contexts.length > BRIDGE_DEFAULTS.maxCachedContexts)
      throw new BridgeFailure(
        "context_invalidated",
        "Too many fragments were prepared for native opening; use a fresh execution.",
      );
    for (const context of contexts) this.options.assertContext(context.retrieval_id);
  }

  prepareCreate(
    bootstrapRef: string,
    identity: BridgeIdentity,
    configHash: string,
  ): { session: BridgeSessionRow; caller: Caller } {
    this.available();
    return this.db
      .transaction(() => {
        const found = this.db
          .query<BridgeSessionRow, [string]>("SELECT * FROM bridge_sessions WHERE bootstrap_hash=?")
          .get(sha256(bootstrapRef));
        if (!found) throw new BridgeFailure("lease_conflict", "The bootstrap reference is unknown.");
        const row = this.live(found.session_id, found.lease_version, "sessions");
        this.assertPendingCreate(row, identity, configHash);
        this.assertPreparedContexts(row);
        const claim = this.toolClaim(row, row.lease_version + 1);
        this.db
          .query(`UPDATE bridge_sessions SET create_seen_at=coalesce(create_seen_at,?),create_seen_lease_version=?,
        create_seen_config_hash=?,tool_token_hash=?,updated_at=? WHERE session_id=?`)
          .run(
            this.time(),
            row.lease_version,
            configHash,
            sha256(claim.credentialId),
            this.time(),
            row.session_id,
          );
        this.options.recordIdentity(row, true);
        return {
          session: this.row(row.session_id),
          caller: {
            projectKey: null,
            agentId: row.intended_agent_id,
            provider: identity.provider,
            nonce: this.nonce(row),
            bridge: claim,
          },
        };
      })
      .immediate();
  }
  private assertPendingCreate(row: BridgeSessionRow, identity: BridgeIdentity, configHash: string): void {
    if (
      row.state !== "pending" ||
      row.bootstrap_consumed_at ||
      !row.bootstrap_expires_at ||
      Date.parse(row.bootstrap_expires_at) <= this.options.now()
    )
      throw new BridgeFailure("lease_conflict", "The bootstrap reference is no longer pending.");
    // SDK create has no workspace identity; the observed bind/open gates verify it later.
    const expected = this.identity(row);
    if (expected.provider !== identity.provider || expected.cwd !== identity.cwd) this.denied();
    if (row.create_seen_config_hash && row.create_seen_config_hash !== configHash)
      throw new BridgeFailure("request_conflict", "Native creation was retried with changed configuration.");
  }
  private toolClaim(row: BridgeSessionRow, version: number): BridgeToolClaim {
    return {
      sessionId: row.session_id,
      sessionEpoch: row.session_epoch,
      leaseVersion: version,
      credentialId: this.derive(`agent-tool/${row.session_id}/${row.session_epoch}/${version}`),
    };
  }
  nativeOpen(
    agentId: string,
    identity: BridgeIdentity,
    reason: "create" | "resume" | "refresh" | "import",
  ): BridgeSessionRow {
    const found = this.db
      .query<BridgeSessionRow, [string]>(
        "SELECT * FROM bridge_sessions WHERE actual_agent_id=? AND state='bound'",
      )
      .get(agentId);
    if (!found)
      throw new BridgeFailure(
        "lease_conflict",
        "The managed agent has no observed bound lease; keep the Bots bind gate loaded before Memory's open gate.",
      );
    const row = this.live(found.session_id, found.lease_version);
    if (reason !== "create")
      throw new BridgeFailure(
        "unsupported_version",
        "This SDK cannot prove staged MCP credential rollover; create a fresh managed execution instead of resuming or refreshing.",
      );
    if (canonicalBody(identity) !== canonicalBody(this.identity(row))) this.denied();
    this.assertPreparedContexts(row);
    return row;
  }
  delivery(
    header: string | null,
    id: string,
    version: number,
    options: { feature: "events" | "feedback"; allowPending?: boolean },
  ): { session: BridgeSessionRow; lease: BridgeLeaseRow } {
    const { feature, allowPending = false } = options;
    if (bearer(header).startsWith("pmbc1_"))
      return this.terminal(this.controller(header, feature), id, version, feature);
    const session = this.scoped(header, id, version, feature);
    if (!allowPending && session.state !== "bound")
      throw new BridgeFailure(
        "lease_conflict",
        "An observed native bind is required before reporting execution.",
      );
    return { session, lease: this.lease(id, version) };
  }
  private authenticatedTool(caller: Caller): BridgeSessionRow {
    const claim = caller.bridge;
    if (!claim) throw new BridgeFailure("unauthorized", "A scoped agent-tool credential is required.");
    const row = this.live(claim.sessionId, claim.leaseVersion);
    if (
      row.state !== "bound" ||
      row.session_epoch !== claim.sessionEpoch ||
      row.tool_activated_epoch !== claim.sessionEpoch ||
      row.tool_revoked_at ||
      row.tool_token_hash !== sha256(claim.credentialId) ||
      caller.agentId !== row.actual_agent_id ||
      caller.nonce !== this.nonce(row) ||
      caller.projectKey !== null ||
      caller.provider !== this.identity(row).provider
    )
      this.denied();
    return row;
  }
  validateTool(caller: Caller): void {
    this.authenticatedTool(caller);
  }
  toolPrincipal(caller: Caller): MutationPrincipal {
    const row = this.authenticatedTool(caller);
    const policy = this.grant(row);
    const origin = this.origin(row);
    const id = `bridge:${row.consumer_id}:${origin.executionId}:${row.session_epoch}`;
    return {
      id,
      actorId: id,
      agentId: row.actual_agent_id,
      provider: this.identity(row).provider,
      access: this.access(row),
      defaultNamespace: { kind: "bot", botId: origin.botId },
      assertCurrent: () => {
        this.authenticatedTool(caller);
      },
      allowedMutations: policy.mutationPurposes.includes(origin.purpose) ? policy.mutations : [],
    };
  }
  private expirePending(): void {
    const expired = this.db
      .query<BridgeSessionRow, [string, number]>(
        "SELECT * FROM bridge_sessions WHERE state='pending' AND julianday(expires_at)<=julianday(?) ORDER BY expires_at LIMIT ?",
      )
      .all(this.time(), BRIDGE_DEFAULTS.maxPendingSessions);
    for (const row of expired) this.end(row, "expired", row.expires_at);
  }
  close(): void {
    this.closed = true;
  }
}

export function isManagedBridgeAgent(db: Database, agentId: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM bridge_sessions WHERE intended_agent_id=? OR actual_agent_id=? LIMIT 1")
      .get(agentId, agentId),
  );
}

function bearer(header: string | null): string {
  if (!header?.startsWith("Bearer ") || header.length > 2048)
    throw new BridgeFailure("unauthorized", "A bearer credential is required.");
  return header.slice(7);
}
function requestedPolicy(
  policy: BridgeConsumerPolicy,
  requested: readonly MemoryNamespace[],
): BridgeConsumerPolicy {
  const allowed = new Set([...policy.readNamespaces, ...policy.writeNamespaces].map(namespaceKey));
  if (requested.some((ns) => !allowed.has(namespaceKey(ns))))
    throw new BridgeFailure("scope_denied", "A requested namespace is not owner-granted.");
  const keys = new Set(requested.map(namespaceKey));
  return {
    ...policy,
    readNamespaces: policy.readNamespaces.filter((ns) => keys.has(namespaceKey(ns))),
    writeNamespaces: policy.writeNamespaces.filter((ns) => keys.has(namespaceKey(ns))),
  };
}
