import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { type BridgeToolClaim, BridgeToolClaimSchema } from "../shared/bridge";
import { SERVICE_VERSION } from "./version";

/** A failure the model can act on: a stable machine-readable code plus a short message. */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ToolOutput {
  text: string;
  structuredContent?: Record<string, unknown>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    args: Record<string, unknown>,
    caller: Caller,
    request: ToolRequest,
  ): Promise<string | ToolOutput> | string | ToolOutput;
}

/** Identifies one call so a retried request can be recognised; null for requests without an id. */
export interface ToolRequest {
  id: string | null;
  signal?: AbortSignal;
}

export interface Caller {
  projectKey: string | null;
  agentId: string | null;
  provider: string | null;
  nonce: string | null;
  bridge?: BridgeToolClaim;
}

export interface McpOptions {
  secret: string;
  instructions: string;
  tools: ToolDefinition[];
  serverName?: string;
  serverVersion?: string;
  resolveCaller?: (caller: Caller) => Caller;
  authorizeCaller?: (caller: Caller) => void;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcId = string | number | null;
type MethodHandler = (
  message: JsonRpcRequest,
  caller: Caller,
  signal: AbortSignal,
) => Promise<unknown> | unknown;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_000_000;

export function signCaller(secret: string, caller: Caller): Record<string, string> {
  const payload = Buffer.from(JSON.stringify(caller)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return { Authorization: `Bearer ${payload}.${sig}` };
}

export function verifyCaller(secret: string, header: string | null | undefined): Caller | null {
  const [payload, sig] = header?.startsWith("Bearer ") ? header.slice(7).split(".") : [];
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  // Constant-time compare so response timing does not leak the signature.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return parseCaller(payload);
}

function parseCaller(payload: string): Caller | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const record = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!record.success) return null;
    const fields = record.data;
    const bridge = fields.bridge === undefined ? null : BridgeToolClaimSchema.safeParse(fields.bridge);
    if (bridge && !bridge.success) return null;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      projectKey: text(fields.projectKey),
      agentId: text(fields.agentId),
      provider: text(fields.provider),
      nonce: text(fields.nonce),
      ...(bridge?.success ? { bridge: bridge.data } : {}),
    };
  } catch {
    return null;
  }
}

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function methodTable(options: McpOptions): Record<string, MethodHandler> {
  return {
    initialize: (message) => {
      const requested = String(message.params?.protocolVersion ?? PROTOCOL_VERSIONS[0]);
      return rpcResult(message.id ?? null, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: options.serverName ?? "paseo-memory",
          version: options.serverVersion ?? SERVICE_VERSION,
        },
        instructions: options.instructions,
      });
    },
    ping: (message) => rpcResult(message.id ?? null, {}),
    "tools/list": (message) =>
      rpcResult(message.id ?? null, {
        tools: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }),
    "tools/call": (message, caller, signal) => callTool(options.tools, message, caller, signal),
  };
}

async function callTool(
  tools: ToolDefinition[],
  message: JsonRpcRequest,
  caller: Caller,
  signal: AbortSignal,
): Promise<unknown> {
  const id = message.id ?? null;
  const name = String(message.params?.name ?? "");
  const tool = tools.find((t) => t.name === name);
  if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
  const args = message.params?.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return rpcError(id, -32602, "tool arguments must be a JSON object");
  }
  try {
    const output = await tool.handler(args as Record<string, unknown>, caller, {
      id: id === null ? null : String(id),
      signal,
    });
    const { text, structuredContent } =
      typeof output === "string" ? { text: output, structuredContent: undefined } : output;
    return rpcResult(id, {
      content: [{ type: "text", text }],
      ...(structuredContent ? { structuredContent } : {}),
      isError: false,
    });
  } catch (error) {
    return rpcResult(id, toolFailure(error));
  }
}

function toolFailure(error: unknown) {
  if (error instanceof ToolError) {
    const structuredContent = { error: { code: error.code, message: error.message } };
    return {
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
      structuredContent,
      isError: true,
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

function preflight(req: Request, secret: string): Response | Caller {
  // Reject browser-originated requests (DNS rebinding, drive-by) outright.
  if (req.headers.get("origin")) return Response.json({ error: "origin not allowed" }, { status: 403 });
  if (req.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  return (
    verifyCaller(secret, req.headers.get("authorization")) ??
    Response.json({ error: "unauthorized" }, { status: 401 })
  );
}

function parseBody(body: string): JsonRpcRequest | JsonRpcRequest[] | Response {
  if (body.length > MAX_BODY_BYTES)
    return Response.json({ error: "request body too large" }, { status: 413 });
  try {
    return JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
}

// Notifications get no response, except known non-ping methods, which keep the original wire behavior.
function dispatch(
  methods: Record<string, MethodHandler>,
  message: JsonRpcRequest,
  caller: Caller,
  signal: AbortSignal,
): Promise<unknown> | unknown {
  const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined;
  if (message.id !== undefined && message.id !== null) {
    return method
      ? method(message, caller, signal)
      : rpcError(message.id, -32601, `method not found: ${message.method}`);
  }
  return method && message.method !== "ping" ? method(message, caller, signal) : null;
}

async function collectResponses(
  methods: Record<string, MethodHandler>,
  batch: JsonRpcRequest[],
  caller: Caller,
  signal: AbortSignal,
): Promise<unknown[]> {
  const responses: unknown[] = [];
  for (const item of batch) {
    const response = await dispatch(methods, item, caller, signal);
    if (response !== null) responses.push(response);
  }
  return responses;
}

function respond(message: JsonRpcRequest | JsonRpcRequest[], responses: unknown[]): Response {
  if (responses.length === 0) return new Response(null, { status: 202 });
  const batch = Array.isArray(message) ? message : [message];
  const headers: Record<string, string> = {};
  if (batch.some((m) => m.method === "initialize"))
    headers["Mcp-Session-Id"] = randomBytes(16).toString("hex");
  return Response.json(Array.isArray(message) ? responses : responses[0], { headers });
}

export function createMcpHandler(options: McpOptions): (req: Request) => Promise<Response> {
  const methods = methodTable(options);
  return async (req) => {
    const verified = preflight(req, options.secret);
    if (verified instanceof Response) return verified;
    const caller = options.resolveCaller ? options.resolveCaller(verified) : verified;
    const unauthorized = authorizeCaller(options, caller);
    if (unauthorized) return unauthorized;
    const message = parseBody(await req.text());
    if (message instanceof Response) return message;
    const batch = Array.isArray(message) ? message : [message];
    return respond(message, await collectResponses(methods, batch, caller, req.signal));
  };
}

function authorizeCaller(options: McpOptions, caller: Caller): Response | null {
  try {
    options.authorizeCaller?.(caller);
    return null;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 403 });
  }
}
