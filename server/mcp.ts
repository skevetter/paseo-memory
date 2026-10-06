// Minimal MCP server (Streamable HTTP transport, JSON responses only) hosted inside the plugin
// process on 127.0.0.1. Each injected agent carries an HMAC token bound to its project key, so
// the server knows which project memory to use and the token survives plugin restarts.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

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
}

export interface McpServerOptions {
  port: number;
  secret: string;
  instructions: string;
  tools: ToolDefinition[];
  serverName?: string;
  serverVersion?: string;
  log?: (message: string) => void;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function signCaller(secret: string, caller: Caller): Record<string, string> {
  const payload = Buffer.from(JSON.stringify(caller)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return { Authorization: `Bearer ${payload}.${sig}` };
}

export function verifyCaller(secret: string, header: string | undefined): Caller | null {
  if (!header?.startsWith("Bearer ")) return null;
  const [payload, sig] = header.slice(7).split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Caller>;
    return {
      projectKey: typeof parsed.projectKey === "string" ? parsed.projectKey : null,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
    };
  } catch {
    return null;
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class MemoryMcpServer {
  private server: Server | null = null;
  private readonly options: McpServerOptions;
  readonly url: string;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.url = `http://127.0.0.1:${options.port}/mcp`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.options.log?.(`mcp request failed: ${String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
    });
    server.keepAliveTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") return sendJson(res, 200, { ok: true });
    if (path !== "/mcp") return sendJson(res, 404, { error: "not found" });
    // Reject browser-originated requests (DNS rebinding / drive-by) outright.
    if (req.headers.origin) return sendJson(res, 403, { error: "origin not allowed" });
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE" });
      return void res.end();
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      return void res.end();
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    const caller = verifyCaller(this.options.secret, req.headers.authorization);
    if (!caller) return sendJson(res, 401, { error: "unauthorized" });

    const body = await readBody(req, 1_000_000);
    let message: JsonRpcRequest | JsonRpcRequest[];
    try {
      message = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, "parse error"));
    }
    const batch = Array.isArray(message) ? message : [message];
    const responses: unknown[] = [];
    for (const item of batch) {
      const response = await this.dispatch(item, caller);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      return void res.end();
    }
    const headers: Record<string, string> = {};
    if (batch.some((m) => m.method === "initialize")) headers["Mcp-Session-Id"] = cryptoRandomId();
    sendJson(res, 200, Array.isArray(message) ? responses : responses[0], headers);
  }

  private async dispatch(message: JsonRpcRequest, caller: Caller): Promise<unknown | null> {
    const isNotification = message.id === undefined || message.id === null;
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize": {
        const requested = String(message.params?.protocolVersion ?? PROTOCOL_VERSIONS[0]);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: this.options.serverName ?? "paseo-memory",
              version: this.options.serverVersion ?? "0.1.0",
            },
            instructions: this.options.instructions,
          },
        };
      }
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const tool = this.options.tools.find((t) => t.name === name);
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await tool.handler(args, caller);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `method not found: ${message.method}`);
    }
  }
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cryptoRandomId(): string {
  return randomBytes(16).toString("hex");
}
