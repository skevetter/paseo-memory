// Minimal MCP endpoint (Streamable HTTP transport, JSON responses only) served by the memory
// service on 127.0.0.1. Each injected agent carries an HMAC token bound to its project key and a
// random nonce, so the service knows which project memory to use and which agent made each call,
// and the token survives service restarts.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SERVICE_VERSION } from "./version";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, caller: Caller): Promise<string> | string;
}

export interface Caller {
  projectKey: string | null;
  agentId: string | null;
  provider: string | null;
  // Random per agent.create; agent_links maps it to the Paseo agent id.
  nonce: string | null;
}

export interface McpOptions {
  secret: string;
  instructions: string;
  tools: ToolDefinition[];
  serverName?: string;
  serverVersion?: string;
  // Fills in what the token cannot know at signing time, such as the agent id behind a nonce.
  resolveCaller?: (caller: Caller) => Caller;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcId = string | number | null;
type MethodHandler = (message: JsonRpcRequest, caller: Caller) => Promise<unknown> | unknown;

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
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return parseCaller(payload);
}

function parseCaller(payload: string): Caller | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const fields: Partial<Record<keyof Caller, unknown>> = parsed;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      projectKey: text(fields.projectKey),
      agentId: text(fields.agentId),
      provider: text(fields.provider),
      nonce: text(fields.nonce),
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
    "tools/call": (message, caller) => callTool(options.tools, message, caller),
  };
}

async function callTool(tools: ToolDefinition[], message: JsonRpcRequest, caller: Caller): Promise<unknown> {
  const id = message.id ?? null;
  const name = String(message.params?.name ?? "");
  const tool = tools.find((t) => t.name === name);
  if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
  const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
  try {
    const text = await tool.handler(args, caller);
    return rpcResult(id, { content: [{ type: "text", text }], isError: false });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return rpcResult(id, { content: [{ type: "text", text }], isError: true });
  }
}

// Status responses for requests that never reach JSON-RPC dispatch.
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

// Notifications get no response, except that v0.1 answered every known non-ping method.
function dispatch(
  methods: Record<string, MethodHandler>,
  message: JsonRpcRequest,
  caller: Caller,
): Promise<unknown> | unknown {
  const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined;
  if (message.id !== undefined && message.id !== null) {
    return method
      ? method(message, caller)
      : rpcError(message.id, -32601, `method not found: ${message.method}`);
  }
  return method && message.method !== "ping" ? method(message, caller) : null;
}

async function collectResponses(
  methods: Record<string, MethodHandler>,
  batch: JsonRpcRequest[],
  caller: Caller,
): Promise<unknown[]> {
  const responses: unknown[] = [];
  for (const item of batch) {
    const response = await dispatch(methods, item, caller);
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

// Handles requests to /mcp. Routing and listening belong to the service's HTTP server.
export function createMcpHandler(options: McpOptions): (req: Request) => Promise<Response> {
  const methods = methodTable(options);
  return async (req) => {
    const verified = preflight(req, options.secret);
    if (verified instanceof Response) return verified;
    const caller = options.resolveCaller ? options.resolveCaller(verified) : verified;
    const message = parseBody(await req.text());
    if (message instanceof Response) return message;
    const batch = Array.isArray(message) ? message : [message];
    return respond(message, await collectResponses(methods, batch, caller));
  };
}
