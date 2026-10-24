import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeDiscovery } from "../server/bridge-discovery";
import {
  BRIDGE_DEFAULTS,
  BRIDGE_MAX_REQUEST_BYTES,
  BridgeCapabilitiesSchema,
  BridgeContextRequestSchema,
  BridgeEventRequestSchema,
  BridgeFeedbackRequestSchema,
  type BridgeIdentity,
  type BridgeRotation,
  BridgeSessionRequestSchema,
  type BridgeSettings,
} from "../shared/bridge";
import type { Logger } from "../shared/log";
import { Access } from "./access";
import { BridgeContexts } from "./bridge-context";
import { BridgeFailure } from "./bridge-errors";
import { BridgeEvents } from "./bridge-events";
import { BridgeFeedback } from "./bridge-feedback";
import { BridgeImports } from "./bridge-import";
import { type BridgeSessionRow, BridgeSessions } from "./bridge-sessions";
import type { ContextTokenizer } from "./context-budget";
import { type Caller, signCaller } from "./mcp";
import { MutationError, type MutationPrincipal } from "./mutations";
import type { MemoryStore } from "./store";

export interface BridgeOptions {
  db: Database;
  store: MemoryStore;
  secret: string;
  dataDir: string;
  log: Logger;
  now: () => Date;
  tokenizers?: ReadonlyMap<string, ContextTokenizer>;
}

export class MemoryBridge {
  readonly serverInstanceId = randomUUID();
  readonly sessions: BridgeSessions;
  readonly contexts: BridgeContexts;
  private readonly events: BridgeEvents;
  private readonly feedback: BridgeFeedback;
  readonly imports: BridgeImports;
  private readonly discovery: BridgeDiscovery;
  private mcpUrl: string | null = null;
  constructor(private readonly options: BridgeOptions) {
    this.discovery = new BridgeDiscovery(options.dataDir, this.serverInstanceId);
    this.sessions = new BridgeSessions({
      db: options.db,
      secret: options.secret,
      now: () => options.now().getTime(),
      assertContext: (id) => {
        this.contexts.current(id);
      },
      assertAgent: (agentId, nonce) => {
        if (options.store.lifecycle.contextInvalidated({ agentId, nonce }))
          throw new BridgeFailure(
            "context_invalidated",
            "This managed context contains a forgotten source; use a fresh authorized agent.",
          );
      },
      managedChanged: () => this.discovery.managed(this.sessions.managedAgentIds()),
      recordIdentity: (row, tools) => this.recordIdentity(row, tools),
    });
    const context = {
      db: options.db,
      store: options.store,
      sessions: this.sessions,
      now: () => options.now().toISOString(),
    };
    this.contexts = new BridgeContexts({ ...context, tokenizers: options.tokenizers });
    this.events = new BridgeEvents(context);
    this.feedback = new BridgeFeedback({ ...context, contexts: this.contexts });
    this.imports = new BridgeImports({
      db: options.db,
      store: options.store,
      secret: options.secret,
      now: context.now,
    });
    this.configure(options.store.config.bridge);
  }
  configure(settings: BridgeSettings): void {
    this.contexts.cancelPending();
    this.sessions.configure(settings);
    this.publish();
  }
  rotate(input: BridgeRotation) {
    this.contexts.cancelPending();
    const result = this.sessions.rotate(input);
    this.publish();
    return result;
  }
  endpoint(mcpUrl: string): void {
    const url = new URL(mcpUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp")
      throw new Error("Bridge requires the actual loopback Memory MCP endpoint.");
    this.mcpUrl = url.href;
    this.publish();
  }
  private publish(): void {
    if (this.mcpUrl)
      this.discovery.publish(
        `${new URL(this.mcpUrl).origin}/bridge/v1`,
        this.sessions.credentials(),
        this.options.store.config.bridge.enabled,
      );
  }
  private recordIdentity(row: BridgeSessionRow, tools: boolean): void {
    const nonce = this.sessions.nonce(row);
    const identity = this.sessions.identity(row);
    this.options.store.audit.open({ nonce, projectKey: null, provider: identity.provider, tools });
    this.options.store.audit.link({
      nonce,
      agentId: row.intended_agent_id,
      workspaceId: identity.workspaceId,
      title: null,
    });
    if (tools) this.options.db.query("UPDATE agent_links SET tools=1 WHERE nonce=?").run(nonce);
    this.options.store.cancelStandaloneReviews([row.intended_agent_id]);
  }
  authorizeMcp(caller: Caller): void {
    if (caller.bridge) {
      this.sessions.validateTool(caller);
      return;
    }
    const agentId = caller.agentId ?? (caller.nonce ? this.options.store.audit.agentFor(caller.nonce) : null);
    if (agentId && this.sessions.isManaged(agentId))
      throw new BridgeFailure("unauthorized", "A managed agent cannot use a standalone Memory credential.");
  }
  principal(caller: Caller, tool: string, fallbackId: string): MutationPrincipal {
    if (caller.bridge) {
      const principal = this.sessions.toolPrincipal(caller);
      const row = this.sessions.row(caller.bridge.sessionId);
      if (!["memory_save", "memory_update", "memory_delete", "memory_mutate"].includes(tool))
        this.sessions.live(row.session_id, caller.bridge.leaseVersion, "context");
      return principal;
    }
    const agentId = caller.agentId ?? (caller.nonce ? this.options.store.audit.agentFor(caller.nonce) : null);
    if (agentId && this.sessions.isManaged(agentId))
      throw new BridgeFailure("unauthorized", "A managed agent cannot use a standalone Memory credential.");
    return {
      id: fallbackId,
      actorId: fallbackId,
      access: Access.agent(caller.projectKey),
      agentId,
      provider: caller.provider,
    };
  }
  prepareCreate(input: { bootstrapRef: string; identity: BridgeIdentity; configHash: string }) {
    if (!this.mcpUrl) throw new BridgeFailure("unavailable", "Memory transport is not ready.", true);
    const { session, caller } = this.sessions.prepareCreate(
      input.bootstrapRef,
      input.identity,
      input.configHash,
    );
    return {
      sessionId: session.session_id,
      sessionEpoch: session.session_epoch,
      nonce: this.sessions.nonce(session),
      ownership: this.sessions.ownership(session),
      mcpServer: {
        type: "http" as const,
        url: this.mcpUrl,
        headers: signCaller(this.options.secret, caller),
      },
    };
  }
  open(input: {
    agentId: string;
    identity: BridgeIdentity;
    purpose: "interactive" | "history";
    reason: "create" | "resume" | "refresh" | "import";
  }) {
    return this.options.db
      .transaction(() => {
        if (!this.sessions.isManaged(input.agentId)) return { managed: false, nonce: null, ownership: null };
        if (input.purpose === "history") return { managed: true, nonce: null, ownership: null };
        const row = this.sessions.nativeOpen(input.agentId, input.identity, input.reason);
        return { managed: true, nonce: this.sessions.nonce(row), ownership: this.sessions.ownership(row) };
      })
      .immediate();
  }
  managed(agentIds: readonly string[]): string[] {
    return agentIds.filter((id) => this.sessions.isManaged(id));
  }
  async handle(request: Request): Promise<Response> {
    try {
      this.preflight(request);
      const path = new URL(request.url).pathname;
      if (path === "/bridge/v1/capabilities" && request.method === "GET") {
        const consumerId = this.sessions.controller(request.headers.get("authorization"));
        return Response.json(this.capabilities(consumerId));
      }
      if (request.method !== "POST")
        throw new BridgeFailure("unsupported_version", "This Bridge operation requires POST JSON.");
      const raw = await body(request);
      return Response.json(await this.dispatch(path, request, raw));
    } catch (error) {
      return this.failure(error);
    }
  }
  private preflight(request: Request): void {
    if (request.headers.has("origin") || new URL(request.url).hostname !== "127.0.0.1")
      throw new BridgeFailure("scope_denied", "Bridge is loopback-only and rejects browser-origin requests.");
    this.sessions.available();
  }
  private capabilities(consumerId: string) {
    const allowed = this.sessions.contextAllowed(consumerId);
    const policy = this.options.store.retrievalPolicies.resolve();
    return BridgeCapabilitiesSchema.parse({
      protocolVersion: 1,
      serverInstanceId: this.serverInstanceId,
      features: {
        botNamespaces: true,
        ownershipLeases: true,
        tokenBudget: true,
        cycleEvents: true,
        feedback: true,
      },
      limits: {
        maxContextTokens: allowed ? policy.limits.maxTokens : 0,
        maxContextChars: allowed ? policy.limits.maxChars : 0,
        maxBodyBytes: BRIDGE_MAX_REQUEST_BYTES,
        maxLeaseSeconds: BRIDGE_DEFAULTS.maxLeaseSeconds,
      },
    });
  }
  private async dispatch(path: string, request: Request, raw: unknown): Promise<unknown> {
    const header = request.headers.get("authorization");
    if (path === "/bridge/v1/sessions") {
      const consumer = this.sessions.controller(header, "sessions");
      return this.sessions.request(consumer, BridgeSessionRequestSchema.parse(raw));
    }
    if (path === "/bridge/v1/context")
      return this.contexts.get(header, BridgeContextRequestSchema.parse(raw), request.signal);
    if (path === "/bridge/v1/events") return this.events.handle(header, BridgeEventRequestSchema.parse(raw));
    if (path === "/bridge/v1/feedback")
      return this.feedback.handle(header, BridgeFeedbackRequestSchema.parse(raw));
    throw new BridgeFailure("unsupported_version", "This Bridge endpoint is not supported.");
  }
  private failure(error: unknown): Response {
    let failure: BridgeFailure;
    if (error instanceof BridgeFailure) failure = error;
    else if (error instanceof z.ZodError || error instanceof SyntaxError)
      failure = new BridgeFailure(
        "unsupported_version",
        "The Bridge v1 request has unsupported fields or values.",
      );
    else if (error instanceof MutationError)
      failure = new BridgeFailure(mutationCode(error.code), error.message);
    else {
      this.options.log.error(
        `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      failure = new BridgeFailure("unavailable", "The Bridge operation could not commit.", true);
    }
    return Response.json(
      { error: { code: failure.bridgeCode, message: failure.message, retryable: failure.retryable } },
      { status: failure.status },
    );
  }
  invalidatePending(): void {
    this.contexts.cancelPending();
  }
  close(): void {
    this.contexts.close();
    this.sessions.close();
    try {
      this.discovery.stopped();
    } catch (error) {
      this.options.log.warn(
        `Bridge discovery shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new BridgeFailure("unsupported_version", "Bridge requires application/json.");
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > BRIDGE_MAX_REQUEST_BYTES)
    throw new BridgeFailure("unsupported_version", "The Bridge request exceeds the byte limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeFailure("unsupported_version", "A JSON request body is required.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > BRIDGE_MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new BridgeFailure("unsupported_version", "The Bridge request exceeds the byte limit.");
    }
    text += decode(decoder, chunk.value, true);
  }
  return JSON.parse(text + decode(decoder));
}
function decode(decoder: TextDecoder, bytes?: Uint8Array, stream = false): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new BridgeFailure("unsupported_version", "Bridge requires valid UTF-8 JSON.");
  }
}
function mutationCode(
  code: string,
): "scope_denied" | "request_conflict" | "context_invalidated" | "revision_conflict" | "unsupported_version" {
  if (
    code === "scope_denied" ||
    code === "request_conflict" ||
    code === "context_invalidated" ||
    code === "revision_conflict"
  )
    return code;
  return "unsupported_version";
}
