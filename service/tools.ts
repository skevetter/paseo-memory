import { z } from "zod";
import { type MutationRequest, MutationRequestSchema } from "../shared/lifecycle";
import { RetrievalRequestSchema, type RetrievalResult } from "../shared/retrieval";
import { MAX_CONTENT_CHARS, MEMORY_TYPES } from "../shared/service-api";
import { Access } from "./access";
import { retrievalAudit, retrievalScore } from "./audit";
import { candidateContextEntry, retrieveContext } from "./context";
import type { ContextTokenizer } from "./context-budget";
import { type Caller, type ToolDefinition, ToolError, type ToolOutput, type ToolRequest } from "./mcp";
import { canonicalBody, MutationError, type MutationPrincipal } from "./mutations";
import { type Reservation, ReviewLimitError, type ReviewOpKind } from "./review-ledger";
import { type CandidateRead, ContentTooLongError, type MemoryStore, type ProjectRef } from "./store";
import { sha256 } from "./text";

export const MCP_INSTRUCTIONS = [
  "paseo-memory: durable memory shared by every Paseo agent on this host.",
  "Global memory applies everywhere; project memory is shared by all worktrees of the same project.",
  "Search (memory_search) before re-deriving past decisions, when the user says 'remember' or 'last time', and before every save.",
  "Save (memory_save) only durable facts: decisions, root causes, conventions, config, and user corrections.",
  "Do not save task progress, plans, chat summaries, or anything the code or git history already records.",
  "One fact per memory, content under about 800 characters, written as What / Why / Where / Learned.",
  "Use topic_key for a topic that evolves so later saves update one entry; use memory_update to correct a memory.",
  "Never save secrets, credentials, raw transcripts, or customer data.",
].join("\n");

export interface ToolContext {
  store: MemoryStore;
  resolveProject(caller: Caller): ProjectRef | null;
  tokenizers?: ReadonlyMap<string, ContextTokenizer>;
}

const MAX_TITLE_CHARS = 200;
const MAX_QUERY_CHARS = 500;
const MAX_TOPIC_CHARS = 200;
// Bounds the request; the real content limit is enforced by the store with a message the model can act on.
const MAX_CONTENT_INPUT_CHARS = MAX_CONTENT_CHARS * 25;

const memoryType = z.enum(MEMORY_TYPES);
const memoryId = z.number().int().positive();
const title = z.string().trim().min(1).max(MAX_TITLE_CHARS);
const topicKey = z.string().trim().min(1).max(MAX_TOPIC_CHARS);
const content = z.string().trim().min(1).max(MAX_CONTENT_INPUT_CHARS);
const retrievalOptions = RetrievalRequestSchema.omit({ ids: true, query: true });

const searchInput = z.strictObject({
  query: z.string().max(MAX_QUERY_CHARS).describe("What to look for."),
  scope: z.enum(["all", "project", "global"]).optional(),
  type: memoryType.optional(),
  limit: z.number().int().min(1).max(25).optional(),
  include_sessions: z.boolean().optional().describe("Also search recent agent session digests."),
  retrieval: retrievalOptions.optional(),
});

const getInput = z.strictObject({
  ids: z.array(memoryId).min(1).max(20),
  retrieval: retrievalOptions.optional(),
});

const saveInput = z.strictObject({
  title: title.describe("Short, searchable title."),
  content: content.describe("What / Why / Where / Learned, under 800 characters."),
  type: memoryType.optional(),
  scope: z.enum(["project", "global"]).optional(),
  topic_key: topicKey.optional().describe("Stable key, e.g. 'auth/token-refresh'."),
  pinned: z.boolean().optional().describe("Pinned memories are injected into every new agent."),
  force: z.boolean().optional().describe("Save even when a similar memory exists."),
  expected_revision: memoryId.optional().describe("Expected current revision for a topic-key update."),
  request_id: z.string().min(1).max(200).optional().describe("Stable retry identity for this mutation."),
});

const updateInput = z
  .strictObject({
    id: memoryId,
    expected_revision: memoryId.optional(),
    request_id: z.string().min(1).max(200).optional(),
    title: title.optional(),
    content: content.optional(),
    type: memoryType.optional(),
    pinned: z.boolean().optional(),
    topic_key: topicKey.optional(),
  })
  .refine(
    (input) => Object.keys(input).some((key) => !["id", "expected_revision", "request_id"].includes(key)),
    {
      message: "provide at least one field to change besides id",
    },
  );

const deleteInput = z.strictObject({
  id: memoryId,
  expected_revision: memoryId.optional(),
  request_id: z.string().min(1).max(200).optional(),
});
const contextInput = RetrievalRequestSchema;

const MUTATION_TOOLS: Partial<Record<string, true>> = {
  memory_save: true,
  memory_update: true,
  memory_delete: true,
  memory_mutate: true,
};

interface InvocationRequest extends ToolRequest {
  admissionAttempted: boolean;
  principalId: string;
  auditNonce: string;
}

interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(
    args: z.output<S>,
    caller: Caller,
    access: Access,
    request: InvocationRequest,
  ): Promise<string | ToolOutput> | string | ToolOutput;
}

// Arguments are parsed before any handler logic runs, so a malformed call can never reach the store.
function defineTool<S extends z.ZodType>(ctx: ToolContext, spec: ToolSpec<S>): ToolDefinition {
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(spec.schema, { io: "input" });
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    async handler(raw, caller, request) {
      const principalId = callerPrincipalId(caller);
      const invocation = {
        ...request,
        admissionAttempted: false,
        principalId,
        auditNonce: caller.nonce ?? principalId,
      };
      try {
        authorizeInvocation(ctx, caller, invocation);
        const args = parseArguments(ctx, spec, raw, invocation.auditNonce);
        return await spec.run(args, caller, Access.agent(caller.projectKey), invocation);
      } catch (error) {
        const failure = MUTATION_TOOLS[spec.name]
          ? mutationFailure(ctx, caller, { tool: spec.name, raw, request: invocation, error })
          : error;
        throw toolError(failure);
      }
    },
  };
}

function authorizeInvocation(ctx: ToolContext, caller: Caller, invocation: InvocationRequest): void {
  if (
    ctx.store.lifecycle.contextInvalidated({
      nonce: invocation.auditNonce,
      agentId: caller.agentId,
      principalId: invocation.principalId,
    })
  )
    throw new MutationError(
      "context_invalidated",
      "A source in this context was forgotten. Start a fresh authorized context.",
    );
  if (caller.agentId && !ctx.store.audit.agentFor(invocation.auditNonce))
    ctx.store.audit.link({
      nonce: invocation.auditNonce,
      agentId: caller.agentId,
      workspaceId: null,
      title: null,
    });
}

function toolError(error: unknown): unknown {
  if (error instanceof ContentTooLongError) return new ToolError("content_too_long", error.message);
  if (error instanceof ReviewLimitError) return new ToolError(error.code, error.message);
  if (error instanceof MutationError) {
    return new ToolError(
      error.code,
      error.details === null ? error.message : `${error.message} ${JSON.stringify(error.details)}`,
    );
  }
  return error;
}

function mutationFailure(
  ctx: ToolContext,
  caller: Caller,
  input: { tool: string; raw: unknown; request: InvocationRequest; error: unknown },
): unknown {
  const { tool, raw, request, error } = input;
  if (error instanceof MutationError && error.code === "context_invalidated") return error;
  if (error instanceof MutationError && error.code === "scope_denied") {
    auditDeniedMutation(ctx, request.auditNonce, tool, raw);
  }
  if (request.admissionAttempted) return error;
  try {
    ctx.store.reviews.rejectAttempt(caller.nonce);
  } catch (limit) {
    return limit;
  }
  return error;
}

function auditDeniedMutation(ctx: ToolContext, auditNonce: string, tool: string, raw: unknown): void {
  const parsed = z
    .object({
      id: memoryId.optional(),
      operation: MutationRequestSchema.shape.operation.optional(),
    })
    .safeParse(raw);
  const operation = parsed.success ? parsed.data.operation : undefined;
  const ids = parsed.success && parsed.data.id ? [parsed.data.id] : [];
  ctx.store.audit.record(auditNonce, { kind: "denied", tool, operation: operation ?? tool, ids });
}

function parseArguments<S extends z.ZodType>(
  ctx: ToolContext,
  spec: ToolSpec<S>,
  raw: unknown,
  auditNonce: string,
): z.output<S> {
  const parsed = spec.schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  ctx.store.audit.record(auditNonce, {
    kind: "invalid",
    tool: spec.name,
    fields: parsed.error.issues.flatMap(issueFields),
  });
  throw new ToolError("invalid_input", describeIssues(parsed.error));
}

function issueFields(issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") return issue.keys;
  return [issue.path.join(".") || "arguments"];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function recordDenied(
  ctx: ToolContext,
  auditNonce: string,
  denial: { tool: string; operation: string; ids: number[] },
): void {
  if (denial.ids.length === 0) return;
  ctx.store.audit.record(auditNonce, { kind: "denied", ...denial });
}

class MutationGate {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Runs a memory change under the review cap. Outside a review the change just runs. Inside one it needs a
   * reservation, and a repeat of the same request returns the first answer instead of changing memory again.
   */
  async run(
    caller: Caller,
    request: InvocationRequest,
    change: { kind: ReviewOpKind; tool: string; args: unknown },
    work: (reservation: Reservation | undefined) => Promise<string> | string,
  ): Promise<string> {
    const key = sha256(canonicalBody([change.tool, request.id, change.args]));
    request.admissionAttempted = true;
    const admission = this.store.reviews.admit(caller.nonce, key, change.kind);
    if (admission.kind === "unrestricted") return work(undefined);
    if (admission.kind === "replay") {
      if (admission.receipt === null)
        throw new ToolError("missing_receipt", "The completed request has no receipt.");
      return admission.receipt;
    }
    const windowId = admission.kind === "in_flight" ? admission.windowId : admission.reservation.windowId;
    const flightKey = `${caller.nonce}:${windowId}:${key}`;
    if (admission.kind === "in_flight") {
      const flight = this.pending.get(flightKey);
      if (flight) return flight;
      throw new ToolError("request_in_flight", "This request is already running. Wait for its answer.");
    }
    const { reservation } = admission;
    const flight = this.finish(reservation, work);
    this.pending.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      this.pending.delete(flightKey);
    }
  }

  private async finish(
    reservation: Reservation,
    work: (reservation: Reservation) => Promise<string> | string,
  ): Promise<string> {
    try {
      const receipt = await work(reservation);
      this.store.reviews.attachReceipt(reservation, receipt);
      return receipt;
    } finally {
      // A no-op when the store already settled the reservation in its own transaction.
      this.store.reviews.release(reservation);
    }
  }
}

const gates = new WeakMap<MemoryStore, MutationGate>();

function gateFor(store: MemoryStore): MutationGate {
  const existing = gates.get(store);
  if (existing) return existing;
  const created = new MutationGate(store);
  gates.set(store, created);
  return created;
}

export function createTools(ctx: ToolContext): ToolDefinition[] {
  return [
    searchTool(ctx),
    getTool(ctx),
    saveTool(ctx),
    updateTool(ctx),
    deleteTool(ctx),
    mutateTool(ctx),
    contextTool(ctx),
  ];
}

function searchTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_search",
    description:
      "Search authorized current memory within owner budgets. Compact references and structured retrieval diagnostics are returned; request an owner-allowed richer profile for more detail.",
    schema: searchInput,
    async run(args, caller, _access, request) {
      const scope = args.scope ?? "all";
      const result = await retrieveContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        mode: "search",
        scope,
        type: args.type,
        includeSessions: args.include_sessions === true,
        excludeAgentId: caller.agentId,
        signal: request.signal,
        tokenizer: ctx.tokenizers?.get(caller.provider ?? ""),
        authorize: () => authorizeInvocation(ctx, caller, request),
        request: {
          ...args.retrieval,
          query: args.query,
          detail: args.retrieval?.detail ?? "compact",
          budget: {
            ...args.retrieval?.budget,
            maxItems: Math.min(args.limit ?? 8, args.retrieval?.budget?.maxItems ?? 25),
          },
        },
        complete: (result, scores) => {
          ctx.store.markShown(result.memoryRefs.map((ref) => ref.id));
          ctx.store.audit.record(request.auditNonce, {
            kind: "search",
            query: args.query,
            scope,
            results: [
              ...result.memoryRefs.map((ref) => ({
                id: String(ref.id),
                score: retrievalScore(scores, `memory:${ref.id}`),
              })),
              ...result.sessionIds.map((id) => ({
                id: `session:${id}`,
                score: retrievalScore(scores, `session:${id}`),
              })),
            ],
            retrieval: retrievalAudit(result),
          });
        },
      });
      return retrievalOutput(result);
    },
  });
}

function retrievalOutput(result: RetrievalResult): ToolOutput {
  const { contextText, ...metadata } = result;
  return { text: contextText, structuredContent: { retrieval: metadata } };
}

function getTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_get",
    description:
      "Fetch bounded authorized detail by ID, including your own proposals. Owner retrieval policies control expansion; omissions and provenance are reported in structured metadata.",
    schema: getInput,
    async run(args, caller, access, request) {
      recordDenied(ctx, request.auditNonce, {
        tool: "memory_get",
        operation: "read",
        ids: ctx.store.deniedIds(access, args.ids),
      });
      const candidates = new Map<number, CandidateRead>();
      const principal = agentPrincipal(caller, access, request.principalId);
      const result = await retrieveContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        mode: "get",
        signal: request.signal,
        tokenizer: ctx.tokenizers?.get(caller.provider ?? ""),
        authorize: () => authorizeInvocation(ctx, caller, request),
        request: { ...args.retrieval, ids: args.ids, detail: args.retrieval?.detail ?? "full" },
        candidate: (id, policy) => {
          const read = ctx.store.readCandidate(access, principal.actorId, id);
          if (!read) return null;
          const entry = candidateContextEntry(read, policy);
          if (entry) candidates.set(id, read);
          return entry;
        },
        complete: (result) => recordGet(ctx, { request, ids: args.ids, result }),
      });
      const output = retrievalOutput(result);
      return {
        ...output,
        structuredContent: {
          ...output.structuredContent,
          records: result.memoryRefs.flatMap((ref) => {
            const read = candidates.get(ref.id);
            return read
              ? [
                  {
                    memoryRef: ref,
                    state: read.memory.state,
                    recordKind: read.memory.record_kind,
                    verificationStatus: read.memory.verification_status,
                  },
                ]
              : [];
          }),
          redirects: args.ids.flatMap((id) => {
            const targetId = ctx.store.mergedIntoVisible(access, id);
            return targetId === null ? [] : [{ id, targetId }];
          }),
        },
      };
    },
  });
}

function recordGet(
  ctx: ToolContext,
  input: { request: InvocationRequest; ids: number[]; result: RetrievalResult },
): void {
  const found = input.result.memoryRefs.map((ref) => ref.id);
  ctx.store.markOpened(found);
  ctx.store.audit.record(input.request.auditNonce, {
    kind: "get",
    ids: input.ids,
    found,
    retrieval: retrievalAudit(input.result),
  });
}

function callerPrincipalId(caller: Caller): string {
  if (caller.nonce) return `nonce:${caller.nonce}`;
  if (caller.agentId) return `agent:${caller.agentId}`;
  return `credential:${sha256(canonicalBody(caller))}`;
}

function agentPrincipal(caller: Caller, access: Access, id: string): MutationPrincipal {
  return { id, actorId: id, access, agentId: caller.agentId, provider: caller.provider };
}

function legacyRequestId(tool: string, args: unknown, request: ToolRequest, explicit?: string): string {
  return explicit ?? `legacy:${tool}:${sha256(canonicalBody(request.id ?? args))}`;
}

interface MutationCall {
  caller: Caller;
  access: Access;
  request: InvocationRequest;
  tool: string;
  kind: ReviewOpKind;
  mutation: MutationRequest;
}

function runMutation(ctx: ToolContext, call: MutationCall): Promise<string> | string {
  const { caller, access, request, tool, kind, mutation } = call;
  const principal = agentPrincipal(caller, access, request.principalId);
  const parsed = MutationRequestSchema.parse(mutation);
  // Replays remain readable even when a new review has no capacity.
  const prior = ctx.store.mutations.replay(principal, parsed);
  if (prior) return JSON.stringify(prior);
  return gateFor(ctx.store).run(caller, request, { kind, tool, args: parsed }, (reservation) => {
    const result = ctx.store.mutations.mutate(principal, parsed, reservation);
    if (kind === "save")
      ctx.store.audit.record(request.auditNonce, {
        kind: "save",
        id: result.memoryRef.id,
        status: result.status,
        candidates: [],
      });
    else if (kind === "delete")
      ctx.store.audit.record(request.auditNonce, {
        kind: "delete",
        id: result.memoryRef.id,
        ok: result.status === "updated" || result.status === "forgotten",
      });
    else
      ctx.store.audit.record(request.auditNonce, {
        kind: "update",
        id: result.memoryRef.id,
        ok: true,
        unchanged: result.status === "unchanged",
      });
    return JSON.stringify(result);
  });
}

function currentRevision(ctx: ToolContext, access: Access, id: number): number {
  const detail = ctx.store.lifecycleDetail(access, id);
  if (!detail) throw new MutationError("scope_denied", "Memory is unavailable.");
  return detail.memoryRef.revision;
}

function assertContentLimit(value: string | undefined): void {
  if (value && value.length > MAX_CONTENT_CHARS) {
    throw new ToolError("content_too_long", `Content over ${MAX_CONTENT_CHARS} characters is rejected.`);
  }
}

function legacySaveTarget(
  ctx: ToolContext,
  args: z.output<typeof saveInput>,
  principal: MutationPrincipal,
  input: { requestId: string; scope: "global" | "project"; project: ProjectRef | null },
): Pick<MutationRequest, "operation" | "id" | "expectedRevision"> {
  const previous = ctx.store.mutations.compatibilityRequest(principal, input.requestId);
  if (previous)
    return previous.operation === "update"
      ? {
          operation: "update",
          id: previous.id,
          expectedRevision: args.expected_revision ?? previous.expectedRevision ?? undefined,
        }
      : { operation: "create" };
  if (!args.topic_key) return { operation: "create" };
  const holder = ctx.store.authorizedTopic(
    principal.access,
    input.scope,
    input.scope === "project" ? (input.project?.key ?? null) : null,
    args.topic_key,
  );
  if (!holder) return { operation: "create" };
  return {
    operation: "update",
    id: holder.id,
    expectedRevision: args.expected_revision ?? holder.record_revision,
  };
}

function saveTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_save",
    description:
      "Save a durable assertion as a candidate, not a verified fact. Search first. " +
      "Use topic_key to correct an existing topic with expected_revision; request_id makes retries idempotent. " +
      "User preferences require owner approval.",
    schema: saveInput,
    run(args, caller, access, request) {
      assertContentLimit(args.content);
      const project = ctx.resolveProject(caller);
      const scope = args.scope === "global" ? "global" : "project";
      if (scope === "project" && !project)
        throw new MutationError(
          "scope_denied",
          "This agent has no resolved project. Use scope=global or skip.",
        );
      const requestId = legacyRequestId("memory_save", args, request, args.request_id);
      const target = legacySaveTarget(ctx, args, agentPrincipal(caller, access, request.principalId), {
        requestId,
        scope,
        project,
      });
      const mutation: MutationRequest = {
        requestId,
        ...target,
        change: {
          title: args.title,
          content: args.content,
          type: args.type ?? "note",
          scope,
          project,
          topicKey: args.topic_key,
          pinned: args.pinned ?? false,
        },
      };
      return runMutation(ctx, { caller, access, request, tool: "memory_save", kind: "save", mutation });
    },
  });
}

function updateTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_update",
    description:
      "Correct a memory with expected_revision and stable request_id. Corrections are candidates; " +
      "prior revisions are retained. Preferences require owner authority.",
    schema: updateInput,
    run(args, caller, access, request) {
      assertContentLimit(args.content);
      const requestId = legacyRequestId("memory_update", args, request, args.request_id);
      const previous = ctx.store.mutations.compatibilityRequest(
        agentPrincipal(caller, access, request.principalId),
        requestId,
      );
      return runMutation(ctx, {
        caller,
        access,
        request,
        tool: "memory_update",
        kind: "update",
        mutation: {
          requestId,
          operation: "update",
          id: args.id,
          expectedRevision:
            args.expected_revision ?? previous?.expectedRevision ?? currentRevision(ctx, access, args.id),
          change: {
            title: args.title,
            content: args.content,
            type: args.type,
            pinned: args.pinned,
            topicKey: args.topic_key,
          },
        },
      });
    },
  });
}

function deleteTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_delete",
    description: "Archive an obsolete memory with expected_revision. Retains history; this is not erasure.",
    schema: deleteInput,
    run(args, caller, access, request) {
      const requestId = legacyRequestId("memory_delete", args, request, args.request_id);
      const previous = ctx.store.mutations.compatibilityRequest(
        agentPrincipal(caller, access, request.principalId),
        requestId,
      );
      return runMutation(ctx, {
        caller,
        access,
        request,
        tool: "memory_delete",
        kind: "delete",
        mutation: {
          requestId,
          operation: "archive",
          id: args.id,
          expectedRevision:
            args.expected_revision ?? previous?.expectedRevision ?? currentRevision(ctx, access, args.id),
        },
      });
    },
  });
}

function mutateTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_mutate",
    description:
      "Apply an evidence-backed lifecycle mutation. Supply a stable requestId and expectedRevision " +
      "for an existing record. Unsupported assertions remain candidates; promotion and preferences require owner authority.",
    schema: MutationRequestSchema,
    run(args, caller, access, request) {
      const kind =
        args.operation === "create" || args.operation === "propose"
          ? "save"
          : args.operation === "archive" || args.operation === "forget"
            ? "delete"
            : "update";
      return runMutation(ctx, { caller, access, request, tool: "memory_mutate", kind, mutation: args });
    },
  });
}

function contextTool(ctx: ToolContext): ToolDefinition {
  return defineTool(ctx, {
    name: "memory_context",
    description:
      "Retrieve an owner-budgeted project/global context bundle. Query or explicit IDs take bounded fast paths; request only an owner-allowed profile. Metadata reports references, counts, omissions and fallback.",
    schema: contextInput,
    async run(args, caller, _access, request) {
      const context = await retrieveContext({
        store: ctx.store,
        project: ctx.resolveProject(caller),
        request: args,
        excludeAgentId: caller.agentId,
        signal: request.signal,
        tokenizer: ctx.tokenizers?.get(caller.provider ?? ""),
        authorize: () => authorizeInvocation(ctx, caller, request),
        complete: (result, _scores, policy) => {
          ctx.store.markShown(result.memoryRefs.map((ref) => ref.id));
          ctx.store.audit.record(request.auditNonce, {
            kind: "context",
            memories: result.memoryRefs.map((ref) => ref.id),
            sessions: result.sessionIds,
            chars: result.usage.chars,
            budget: policy.limits.maxChars,
            retrieval: retrievalAudit(result),
          });
        },
      });
      return retrievalOutput(context);
    },
  });
}
