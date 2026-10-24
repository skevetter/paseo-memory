import { z } from "zod";
import { MemoryRefSchema, MutationRequestSchema, TimestampSchema } from "./lifecycle";
import { MemoryNamespaceSchema } from "./namespaces";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_BOOTSTRAP_ENV = "PASEO_MEMORY_BOOTSTRAP_REF";
export const BRIDGE_MAX_REQUEST_BYTES = 16_384;
export const BRIDGE_FIXTURE_SHA256 = "e49e9ea7079b4cd6cfa0d18fd902b3d535087f60af71fcb135207cd6de9dfa0e";
export const BRIDGE_DEFAULTS = Object.freeze({
  leaseSeconds: 300,
  maxLeaseSeconds: 900,
  bootstrapSeconds: 120,
  terminalSeconds: 86_400,
  maxPendingSessions: 64,
  maxPendingEvents: 256,
  maxCachedContexts: 128,
});

const Identifier = z.string().min(1).max(200);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Positive = Counter.min(1);
const References = z.array(z.string().min(1).max(1000)).max(32);
const Namespaces = z.array(MemoryNamespaceSchema).max(32);
export const BridgePurposeSchema = z.enum(["task", "memory_review", "evaluation", "maintenance"]);
export type BridgePurpose = z.infer<typeof BridgePurposeSchema>;
export const BridgeOwnershipSchema = z.strictObject({
  contextOwner: z.literal("paseo-bots"),
  captureOwner: z.literal("paseo-bots"),
  reviewOwner: z.literal("paseo-bots"),
});
export type BridgeOwnership = z.infer<typeof BridgeOwnershipSchema>;
export const BridgeIdentitySchema = z.strictObject({
  workspaceId: Identifier.nullable(),
  provider: Identifier,
  cwd: z.string().min(1).max(4096),
});
export type BridgeIdentity = z.infer<typeof BridgeIdentitySchema>;
export const BridgeOriginSchema = z.strictObject({
  botId: Identifier,
  runId: Identifier,
  cycleId: Identifier,
  attemptId: Identifier,
  executionId: Identifier,
  sessionEpoch: Positive,
  agentId: Identifier,
  providerTurnId: Identifier.nullable(),
  purpose: BridgePurposeSchema,
});
export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;
const Envelope = z.strictObject({ protocolVersion: z.literal(1), requestId: Identifier });
const SessionEnvelope = Envelope.extend({ sessionId: Identifier, leaseVersion: Positive });
export const BridgeRegisterSchema = z.strictObject({
  ...Envelope.shape,
  ...BridgeOriginSchema.shape,
  action: z.literal("register"),
  expectedIdentity: BridgeIdentitySchema,
  requestedNamespaces: Namespaces,
  ownership: BridgeOwnershipSchema,
});
export const BridgeBindSchema = z.strictObject({
  ...SessionEnvelope.shape,
  action: z.literal("bind"),
  actualAgentId: Identifier,
  observedIdentity: BridgeIdentitySchema,
  sessionEpoch: Positive,
  bootstrapRef: Identifier.optional(),
});
export const BridgeRenewReleaseSchema = z.strictObject({
  ...SessionEnvelope.shape,
  action: z.enum(["renew", "release"]),
});
export const BridgeSessionRequestSchema = z.discriminatedUnion("action", [
  BridgeRegisterSchema,
  BridgeBindSchema,
  BridgeRenewReleaseSchema,
]);
export type BridgeSessionRequest = z.infer<typeof BridgeSessionRequestSchema>;
export const BridgeSessionResultSchema = z.strictObject({
  protocolVersion: z.literal(1),
  sessionId: Identifier,
  leaseVersion: Positive,
  expiresAt: TimestampSchema,
  grantedNamespaces: Namespaces,
  ownership: BridgeOwnershipSchema,
  sessionToken: z.string().min(1).max(512),
  bootstrapRef: Identifier.optional(),
});
export type BridgeSessionResult = z.infer<typeof BridgeSessionResultSchema>;

// Signed MCP claims are separate from both controller and controller-held session credentials.
export const BridgeToolClaimSchema = z.strictObject({
  sessionId: Identifier,
  sessionEpoch: Positive,
  leaseVersion: Positive,
  credentialId: z.string().min(32).max(200),
});
export type BridgeToolClaim = z.infer<typeof BridgeToolClaimSchema>;

export const BRIDGE_MANAGED_REGISTRY = "bridge/managed-agents.json";
export const ManagedAgentRegistrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  agentIds: z.array(Identifier),
});
export const BridgeNativeCreateResultSchema = z.strictObject({
  sessionId: Identifier,
  sessionEpoch: Positive,
  nonce: Identifier,
  ownership: BridgeOwnershipSchema,
  mcpServer: z.strictObject({
    type: z.literal("http"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
});
export const BridgeNativeOpenResultSchema = z.strictObject({
  managed: z.boolean(),
  nonce: Identifier.nullable(),
  ownership: BridgeOwnershipSchema.nullable(),
});
export const BridgeContextRequestSchema = z.strictObject({
  ...SessionEnvelope.shape,
  query: z.string().max(4000),
  namespaceFilter: Namespaces,
  recordKinds: z.array(z.string().min(1).max(50)).max(32),
  asOf: TimestampSchema.optional(),
  budget: z.strictObject({
    maxTokens: Counter.max(32_768),
    maxChars: Counter.max(20_000),
    maxLatencyMs: Counter.max(5000),
    tokenizerId: Identifier.optional(),
  }),
});
export type BridgeContextRequest = z.infer<typeof BridgeContextRequestSchema>;
export const BridgeContextResultSchema = z.strictObject({
  protocolVersion: z.literal(1),
  retrievalId: Identifier,
  contextText: z.string(),
  memoryRefs: z.array(MemoryRefSchema).max(100),
  evidenceRefs: z.array(z.string().min(1).max(1000)),
  usage: z.strictObject({
    tokenCount: Counter,
    tokenCountIsEstimate: z.boolean(),
    estimator: z.string(),
    chars: Counter,
    latencyMs: z.number().min(0),
  }),
  truncated: z.boolean(),
  omittedCount: Counter,
  fallbackReason: z.string().nullable(),
  policyRevision: Counter,
  indexGeneration: Counter,
});
export type BridgeContextResult = z.infer<typeof BridgeContextResultSchema>;
export const BridgeCycleEventSchema = z.strictObject({
  ...BridgeOriginSchema.shape,
  type: z.literal("cycle.completed"),
  eventId: Identifier,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  summary: z.string().max(4000),
  sourceRefs: References,
  memoryRefs: z.array(MemoryRefSchema).max(100),
  outcome: z.strictObject({
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    verifierId: Identifier.optional(),
    verifierVersion: Identifier.optional(),
    evidenceRefs: References,
  }),
  modelUsageRefs: References,
});
export type BridgeCycleEvent = z.infer<typeof BridgeCycleEventSchema>;
export const BridgeEventRequestSchema = z.strictObject({
  ...SessionEnvelope.shape,
  event: BridgeCycleEventSchema,
});
export type BridgeEventRequest = z.infer<typeof BridgeEventRequestSchema>;
export const BridgeEventAckSchema = z.strictObject({
  protocolVersion: z.literal(1),
  eventId: Identifier,
  status: z.enum(["accepted", "duplicate"]),
  eventRef: z.string().min(1).max(1000),
});
export type BridgeEventAck = z.infer<typeof BridgeEventAckSchema>;
export const BridgeFeedbackRequestSchema = z.strictObject({
  ...SessionEnvelope.shape,
  retrievalId: Identifier,
  runId: Identifier,
  cycleId: Identifier,
  delivery: z
    .strictObject({
      status: z.enum(["attached", "discarded", "unknown"]),
      executionId: Identifier,
      promptFingerprint: z.string().min(1).max(200).optional(),
    })
    .optional(),
  assessments: z
    .array(
      z.strictObject({
        memoryRef: MemoryRefSchema,
        signal: z.enum(["applied", "helpful", "harmful", "irrelevant"]),
        basis: z.enum(["validator", "human", "agent_report"]),
        evidenceRefs: References,
      }),
    )
    .max(100),
});
export type BridgeFeedbackRequest = z.infer<typeof BridgeFeedbackRequestSchema>;
export const BridgeFeedbackAckSchema = z.strictObject({
  protocolVersion: z.literal(1),
  retrievalId: Identifier,
  status: z.enum(["accepted", "duplicate"]),
});
export type BridgeFeedbackAck = z.infer<typeof BridgeFeedbackAckSchema>;
export const BridgeCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  serverInstanceId: Identifier,
  features: z.strictObject({
    botNamespaces: z.boolean(),
    ownershipLeases: z.boolean(),
    tokenBudget: z.boolean(),
    cycleEvents: z.boolean(),
    feedback: z.boolean(),
  }),
  limits: z.strictObject({
    maxContextTokens: Counter,
    maxContextChars: Counter,
    maxBodyBytes: Positive,
    maxLeaseSeconds: Positive,
  }),
});
export type BridgeCapabilities = z.infer<typeof BridgeCapabilitiesSchema>;
export const BridgeErrorCodeSchema = z.enum([
  "unauthorized",
  "scope_denied",
  "lease_expired",
  "lease_conflict",
  "request_conflict",
  "context_invalidated",
  "revision_conflict",
  "budget_exhausted",
  "unavailable",
  "unsupported_version",
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;
export const BridgeErrorSchema = z.strictObject({
  error: z.strictObject({
    code: BridgeErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const BridgeFunctionSchema = z.enum(["sessions", "context", "events", "feedback"]);
export const BridgeConsumerPolicySchema = z.strictObject({
  id: Identifier,
  readNamespaces: Namespaces.default([]),
  writeNamespaces: Namespaces.default([]),
  functions: z.array(BridgeFunctionSchema).max(4).default(["sessions", "context", "events", "feedback"]),
  mutations: z.array(MutationRequestSchema.shape.operation).max(12).default(["create", "propose"]),
  mutationPurposes: z.array(BridgePurposeSchema).max(4).default(["memory_review"]),
});
export type BridgeConsumerPolicy = z.infer<typeof BridgeConsumerPolicySchema>;
export const BridgeSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  consumers: z.array(BridgeConsumerPolicySchema).max(16).default([]),
  leaseSeconds: Positive.max(BRIDGE_DEFAULTS.maxLeaseSeconds).default(BRIDGE_DEFAULTS.leaseSeconds),
  bootstrapSeconds: Positive.max(BRIDGE_DEFAULTS.bootstrapSeconds).default(BRIDGE_DEFAULTS.bootstrapSeconds),
  terminalSeconds: Positive.max(BRIDGE_DEFAULTS.terminalSeconds).default(BRIDGE_DEFAULTS.terminalSeconds),
});
export type BridgeSettings = z.infer<typeof BridgeSettingsSchema>;
export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = BridgeSettingsSchema.parse({});

// Owner-only operational controls, not additional Bridge v1 wire endpoints.
export const BridgeRotationSchema = z.strictObject({
  consumerId: Identifier,
  expectedVersion: Positive,
  requestId: Identifier,
});
export type BridgeRotation = z.infer<typeof BridgeRotationSchema>;
export const BridgeRotationResultSchema = z.strictObject({
  consumerId: Identifier,
  credentialVersion: Positive,
});
export type BridgeRotationResult = z.infer<typeof BridgeRotationResultSchema>;
export interface BridgeOwnerStatus {
  enabled: boolean;
  consumers: Array<{ policy: BridgeConsumerPolicy; enabled: boolean; credentialVersion: number }>;
  native: {
    createObservation: "provider_cwd_only";
    credentialRollover: "unsupported_new_execution_required";
    pairedValidation: "not_qualified";
    trustedEvidenceResolver: "unavailable";
  };
}
