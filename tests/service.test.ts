import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller, verifyCaller } from "../service/mcp";
import { silentLogger } from "../shared/log";
import { AgentAuditSchema, MAX_CONTENT_CHARS, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, tempDir } from "./helpers";

let service: RunningService;
beforeAll(async () => {
  service = await startService({
    dataDir: tempDir("pm-service-"),
    port: 0,
    tier: "zero",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.embedderReady();
});
afterAll(() => service.stop());

const internalUrl = (route: string) => `http://127.0.0.1:${service.port}/v1/${route}`;

async function internal(route: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(internalUrl(route), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SERVICE_KEY_HEADER]: serviceKey(service.secret),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: z.record(z.string(), z.unknown()).parse(await response.json()) };
}

async function mcp(body: unknown, headers: Record<string, string>) {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: response.status === 202 ? null : ((await response.json()) as unknown),
  };
}

const ToolCallResponse = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) });
const InitResponse = z.object({ result: z.object({ serverInfo: z.object({ name: z.string() }) }) });
const ListResponse = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });

const toolText = (result: { json: unknown }): string | undefined =>
  ToolCallResponse.parse(result.json).result.content[0]?.text;

describe("mcp endpoint", () => {
  it("authenticates, lists tools, and saves and searches scoped by the signed project", async () => {
    service.store.upsertProject(dataRepo);
    const auth = signCaller(service.secret, {
      projectKey: dataRepo.key,
      agentId: null,
      provider: "claude",
      nonce: null,
    });
    expect((await mcp({}, {})).status).toBe(401);
    expect((await mcp({}, { ...auth, Origin: "http://evil.example" })).status).toBe(403);

    const init = await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
      auth,
    );
    expect(InitResponse.parse(init.json).result.serverInfo.name).toBe("paseo-memory");
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, auth)).status).toBe(202);
    const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
    expect(ListResponse.parse(list.json).result.tools.map((t) => t.name)).toEqual([
      "memory_search",
      "memory_get",
      "memory_save",
      "memory_update",
      "memory_delete",
      "memory_context",
    ]);
    const saved = await mcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_save",
          arguments: {
            title: "Airflow DAG naming",
            content: "What: dag ids are snake_case",
            type: "pattern",
          },
        },
      },
      auth,
    );
    expect(toolText(saved)).toMatch(/^created: #\d+ \(project: data\/data-team\)$/);
    const found = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "airflow dag" } },
      },
      auth,
    );
    expect(toolText(found)).toContain("Airflow DAG naming");

    // A token for another project cannot see it.
    const other = signCaller(service.secret, {
      projectKey: "remote:github.com/x/y",
      agentId: null,
      provider: null,
      nonce: null,
    });
    const hidden = await mcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "airflow dag", scope: "project" } },
      },
      other,
    );
    expect(toolText(hidden)).toBe("No matching memories.");
  });

  it("rejects tampered and foreign-secret tokens", () => {
    const header =
      signCaller("s", { projectKey: "k", agentId: null, provider: null, nonce: null }).Authorization ?? "";
    const [payload, sig] = header.slice(7).split(".");
    const forged = Buffer.from(JSON.stringify({ projectKey: "other" })).toString("base64url");
    expect(verifyCaller("s", header)?.projectKey).toBe("k");
    expect(verifyCaller("s", `Bearer ${forged}.${sig}`)).toBeNull();
    expect(verifyCaller("wrong", `Bearer ${payload}.${sig}`)).toBeNull();
  });
});

describe("internal api", () => {
  it("requires the derived key and rejects browser origins and MCP caller tokens", async () => {
    expect((await internal("status", {}, { [SERVICE_KEY_HEADER]: "nope" })).status).toBe(401);
    expect((await internal("status", {}, { Origin: "http://evil.example" })).status).toBe(403);
    const agentToken = signCaller(service.secret, {
      projectKey: null,
      agentId: null,
      provider: null,
      nonce: null,
    });
    const response = await fetch(internalUrl("status"), { method: "POST", headers: agentToken, body: "{}" });
    expect(response.status).toBe(401);
    expect((await internal("nope", {})).status).toBe(404);
    expect((await internal("search", { query: 1 })).status).toBe(400);
  });

  it("reports versions, the vec0 extension and the active tier in status", async () => {
    const { json } = await internal("status", {});
    expect(json.sqliteVecVersion).toBe("v0.1.9");
    expect(json.bunVersion).toBe(Bun.version);
    expect(json.embedder).toMatchObject({ tier: "zero", state: "ready", model: "minishlab/potion-base-8M" });
  });

  it("builds the agent context block and a signed MCP server entry for agent.create", async () => {
    const save = await internal("save", {
      title: "Pinned in UI",
      content: "Run make lint",
      type: "pattern",
      scope: "project",
      paseoProjectId: "prj_new",
      project: { ...dataRepo, paseoProjectId: "prj_new" },
      pinned: true,
    });
    expect(save.json).toMatchObject({ status: "created" });
    const { json } = await internal("agent-context", {
      project: dataRepo,
      provider: "omp",
      includeContext: true,
      includeTools: true,
    });
    const context = z
      .object({
        systemPrompt: z.string(),
        mcpServer: z.object({ url: z.string(), headers: z.object({ Authorization: z.string() }) }),
      })
      .parse(json);
    expect(context.systemPrompt).toContain("Pinned in UI");
    expect(context.mcpServer.url).toBe(service.mcpUrl);
    expect(verifyCaller(service.secret, context.mcpServer.headers.Authorization)).toEqual({
      projectKey: dataRepo.key,
      agentId: null,
      provider: "omp",
      nonce: expect.any(String),
    });
    expect((await internal("project-known", { paseoProjectId: "prj_new" })).json).toEqual({ known: true });
    const search = await internal("search", {
      query: "lint",
      paseoProjectId: "prj_new",
      scope: "project",
      limit: 5,
    });
    const items = z.array(z.object({ title: z.string() })).parse(search.json.items);
    expect(items.map((i) => i.title)).toEqual(["Pinned in UI"]);
  });
});

const ToolResult = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })), isError: z.boolean() }),
});

describe("agent audit", () => {
  it("records the injection and every tool call under the nonce and shows them once linked", async () => {
    await internal("save", {
      title: "Deploys run from main",
      content: "What: CI deploys the main branch only",
      type: "config",
      scope: "project",
      paseoProjectId: null,
      project: dataRepo,
      pinned: true,
    });
    const created = await internal("agent-context", {
      project: dataRepo,
      provider: "omp",
      includeContext: true,
      includeTools: true,
    });
    const ctx = z
      .object({ nonce: z.string(), mcpServer: z.object({ headers: z.record(z.string(), z.string()) }) })
      .parse(created.json);
    const call = async (id: number, name: string, args: Record<string, unknown>) =>
      ToolResult.parse(
        (
          await mcp(
            { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
            ctx.mcpServer.headers,
          )
        ).json,
      ).result;

    expect((await internal("agent-audit", { agentId: "agent-x" })).json).toMatchObject({
      linked: false,
      injected: null,
      events: [],
    });
    await call(1, "memory_search", { query: "deploys main branch" });
    const saved = await call(2, "memory_save", {
      title: "Staging runs in us-east-1",
      content: "Where: infra/terraform/staging",
      type: "config",
    });
    const id = Number(/#(\d+)/.exec(saved.content[0]?.text ?? "")?.[1]);
    await call(3, "memory_get", { ids: [id, 99999] });
    const tooLong = await call(4, "memory_save", {
      title: "Huge",
      content: "x".repeat(MAX_CONTENT_CHARS + 1),
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0]?.text).toContain(`limit is ${MAX_CONTENT_CHARS}`);

    await internal("link-agent", {
      nonce: ctx.nonce,
      agentId: "agent-x",
      workspaceId: "ws-1",
      title: "Deploys",
    });
    // After the link, saves carry the agent id.
    const later = await call(5, "memory_save", {
      title: "Prod runs in eu-west-1",
      content: "Where: infra/prod",
      type: "config",
    });
    const laterId = Number(/#(\d+)/.exec(later.content[0]?.text ?? "")?.[1]);
    expect((await internal("detail", { id: laterId })).json).toMatchObject({
      memory: { agentId: "agent-x" },
    });

    const audit = AgentAuditSchema.parse((await internal("agent-audit", { agentId: "agent-x" })).json);
    expect(audit).toMatchObject({
      linked: true,
      provider: "omp",
      title: "Deploys",
      projectName: dataRepo.name,
    });
    expect(audit.injected?.memories.map((m) => m.title)).toContain("Deploys run from main");
    expect(audit.injected?.budget).toBe(6000);
    expect(audit.events.map((e) => e.kind)).toEqual(["search", "save", "get", "save"]);
    const [search, save, get] = audit.events;
    expect(search?.query).toBe("deploys main branch");
    expect(search?.memories[0]).toMatchObject({ title: "Deploys run from main", score: expect.any(Number) });
    expect(save?.memories).toEqual([
      { id, title: "Staging runs in us-east-1", score: null, status: "created" },
    ]);
    expect(get?.memories.map((m) => m.status)).toEqual(["found", "missing"]);

    const agents = (await internal("workspace-agents", { workspaceId: "ws-1", limit: 5 })).json;
    expect(agents).toMatchObject({ agents: [{ agentId: "agent-x", title: "Deploys", events: 5 }] });
  });
});
