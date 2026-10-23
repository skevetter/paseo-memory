import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller, verifyCaller } from "../service/mcp";
import { MutationResultSchema } from "../shared/lifecycle";
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
  await service.modelsReady();
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

const toolText = (result: { json: unknown }): string | undefined =>
  ToolCallResponse.parse(result.json).result.content[0]?.text;

describe("mcp endpoint", () => {
  it("authenticates and scopes retrieval while keeping unreviewed assertions out of search", async () => {
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
    const candidate = MutationResultSchema.parse(JSON.parse(toolText(saved) ?? "{}"));
    expect(candidate.state).toBe("candidate");
    const found = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "airflow dag" } },
      },
      auth,
    );
    expect(toolText(found)).not.toContain("Airflow DAG naming");
    const promoted = await internal("mutate", {
      requestId: "approve-dag-naming",
      operation: "promote",
      id: candidate.memoryRef.id,
      expectedRevision: candidate.memoryRef.revision,
    });
    expect(promoted.status).toBe(200);
    const active = await mcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "airflow dag" } },
      },
      auth,
    );
    expect(toolText(active)).toContain("Airflow DAG naming");

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
    expect(toolText(hidden)).not.toContain("Airflow DAG naming");
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
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    isError: z.boolean(),
    structuredContent: z.object({ error: z.object({ code: z.string() }) }).optional(),
  }),
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
    const id = savedId(saved);
    await call(3, "memory_get", { ids: [id, 99999] });
    const tooLong = await call(4, "memory_save", {
      title: "Huge",
      content: "x".repeat(MAX_CONTENT_CHARS + 1),
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.structuredContent?.error.code).toBe("content_too_long");

    await internal("link-agent", {
      nonce: ctx.nonce,
      agentId: "agent-x",
      workspaceId: "ws-1",
      title: "Deploys",
    });
    const later = await call(5, "memory_save", {
      title: "Prod runs in eu-west-1",
      content: "Where: infra/prod",
      type: "config",
    });
    const laterId = savedId(later);
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

const ContextOutput = z.object({
  nonce: z.string(),
  systemPrompt: z.string(),
  mcpServer: z.object({ headers: z.record(z.string(), z.string()) }),
});

async function startAgent(
  agentId: string,
  task: { query: string; source: "prompt" | "names" } | null,
  project: typeof dataRepo | null = dataRepo,
) {
  const created = await internal("agent-context", {
    project,
    provider: "omp",
    includeContext: true,
    includeTools: true,
    task,
    taskBudgetMs: 1000,
  });
  const ctx = ContextOutput.parse(created.json);
  await internal("link-agent", { nonce: ctx.nonce, agentId, workspaceId: "ws-2", title: null });
  let id = 100;
  const call = async (name: string, args: Record<string, unknown>) =>
    ToolResult.parse(
      (
        await mcp(
          { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } },
          ctx.mcpServer.headers,
        )
      ).json,
    ).result;
  return { ...ctx, call };
}

const savedId = (result: { content: { text: string }[] }) =>
  MutationResultSchema.parse(JSON.parse(result.content[0]?.text ?? "{}")).memoryRef.id;

describe("task-aware start", () => {
  it("injects task matches above the general lists and records the query and matches", async () => {
    const saved = await internal("save", {
      title: "Gateway limits",
      content: "Payment retries stop after three attempts because the gateway rate limits us",
      type: "config",
      scope: "project",
      paseoProjectId: null,
      project: dataRepo,
      pinned: false,
    });
    const id = Number(saved.json.id);
    const agent = await startAgent("agent-task", {
      query: "why do payment retries stop after three attempts",
      source: "prompt",
    });
    const block = agent.systemPrompt.split("\n");
    const heading = block.indexOf("## Relevant to this task");
    expect(heading).toBeGreaterThan(0);
    expect(block[heading + 1]).toContain(`#${id} [config] Gateway limits`);
    expect(heading).toBeLessThan(block.findIndex((l) => l.startsWith("## Pinned")));
    const audit = AgentAuditSchema.parse((await internal("agent-audit", { agentId: "agent-task" })).json);
    expect(audit.injected?.task).toMatchObject({
      query: "why do payment retries stop after three attempts",
      source: "prompt",
      memories: [{ id, title: "Gateway limits", score: expect.any(Number) }],
      note: null,
    });

    await agent.call("memory_get", { ids: [id] });
    const other = await internal("save", {
      title: "Unseen note",
      content: "never shown to the agent",
      type: "note",
      scope: "global",
      paseoProjectId: null,
      project: null,
      pinned: false,
    });
    await agent.call("memory_get", { ids: [Number(other.json.id)] });
    expect((await internal("detail", { id })).json).toMatchObject({ memory: { openedCount: 1 } });
    expect((await internal("detail", { id: Number(other.json.id) })).json).toMatchObject({
      memory: { openedCount: 0, useCount: 1 },
    });
  });
});

describe("session review", () => {
  it("caps saves inside a review, stores the summary and outcomes, and records the review", async () => {
    const agentId = "agent-review";
    const agent = await startAgent(agentId, null);
    const turn = {
      agentId,
      project: dataRepo,
      provider: "omp",
      title: "Retries",
      workspaceDir: null,
      files: [],
    };
    await internal("record-turn", { ...turn, userText: "make retries safer", assistantText: "Done." });
    expect((await internal("review-start", { agentId, trigger: "idle" })).json).toEqual({
      ok: true,
      reason: null,
      cap: 3,
    });
    const ids: number[] = [];
    for (const n of [1, 2, 3]) {
      ids.push(
        savedId(await agent.call("memory_save", { title: `Review fact ${n}`, content: `fact number ${n}` })),
      );
    }
    const fourth = await agent.call("memory_save", { title: "Review fact 4", content: "one too many" });
    expect(fourth.isError).toBe(true);
    const reply = `[paseo-memory:review-reply v1 collapsed]\nSummary: Capped retries at three and kept backoff.\nSaved: #${ids.join(", #")}\nUpdated: none`;
    const ended = await internal("review-end", { agentId, reply, failed: false });
    expect(ended.json).toEqual({
      ok: true,
      saved: ids,
      updated: [],
      summary: "Capped retries at three and kept backoff.",
    });
    expect(
      (await agent.call("memory_save", { title: "After review", content: "normal save again" })).isError,
    ).toBe(false);

    const sessions = z
      .object({
        items: z.array(
          z.object({ agentId: z.string(), summary: z.string().nullable(), outcomes: z.string().nullable() }),
        ),
      })
      .parse(
        (await internal("sessions", { query: "backoff", paseoProjectId: dataRepo.paseoProjectId, limit: 5 }))
          .json,
      );
    const session = sessions.items.find((s) => s.agentId === agentId);
    expect(session).toMatchObject({ agentId, summary: "Capped retries at three and kept backoff." });
    for (const [index, id] of ids.entries()) {
      expect(session?.outcomes).toContain(`#${id}`);
      expect(session?.outcomes).toContain(`Review fact ${index + 1}`);
    }
    const next = await startAgent("agent-next", null);
    expect(next.systemPrompt).toContain("Capped retries at three and kept backoff.");
    const audit = AgentAuditSchema.parse((await internal("agent-audit", { agentId })).json);
    const review = audit.events.find((e) => e.kind === "review");
    expect(review).toMatchObject({ text: "Capped retries at three and kept backoff." });
    expect(review?.memories.map((m) => m.status)).toEqual(["saved", "saved", "saved"]);
  });

  it("declines agents without memory tools and records skipped reviews", async () => {
    expect(
      (await internal("review-start", { agentId: "agent-unknown", trigger: "idle" })).json,
    ).toMatchObject({ ok: false });
    await startAgent("agent-busy", null);
    await internal("review-skip", { agentId: "agent-busy", trigger: "turns", reason: "The agent is busy." });
    const audit = AgentAuditSchema.parse((await internal("agent-audit", { agentId: "agent-busy" })).json);
    expect(audit.events).toMatchObject([{ kind: "review" }]);
  });
});

it("counts preflight and admitted failures once, and never recharges an authorized replay", async () => {
  const fixture = await internal("save", {
    title: "Attempt budget fixture",
    content: "A real editable record",
    type: "note",
    scope: "global",
    paseoProjectId: null,
    project: null,
    pinned: false,
  });
  const ref = MutationResultSchema.parse(fixture.json).memoryRef;
  const reviewer = await startAgent("preflight-attempt-review", null);
  await internal("review-start", { agentId: "preflight-attempt-review", trigger: "idle" });
  const attempts: [string, Record<string, unknown>][] = [
    ["memory_update", { id: 999999, content: "Unavailable record" }],
    ["memory_save", { title: "Oversized", content: "x".repeat(MAX_CONTENT_CHARS + 1) }],
    ["memory_update", { id: "malformed", title: "Invalid arguments" }],
    [
      "memory_mutate",
      {
        requestId: "admitted-cas-failure",
        operation: "update",
        id: ref.id,
        expectedRevision: ref.revision + 1,
        change: { content: "Stale correction" },
      },
    ],
  ];
  for (const [index, [name, args]] of attempts.entries()) {
    expect((await reviewer.call(name, args)).isError).toBe(true);
    expect(service.store.reviews.info(reviewer.nonce)).toMatchObject({ attempts: index + 1, committed: 0 });
  }
  const mutation = {
    title: "Idempotent review candidate",
    content: "A bounded candidate assertion",
    request_id: "attempt-budget-create",
  };
  const first = await reviewer.call("memory_save", mutation);
  expect(first.isError).toBe(false);
  const replay = await reviewer.call("memory_save", mutation);
  expect(replay).toEqual(first);
  expect(service.store.reviews.info(reviewer.nonce)).toMatchObject({ attempts: 5, committed: 1 });
  const conflict = await reviewer.call("memory_save", { ...mutation, content: "Different retry body" });
  expect(conflict.structuredContent?.error.code).toBe("request_conflict");
  expect(service.store.reviews.info(reviewer.nonce)).toMatchObject({ attempts: 6, committed: 1 });

  const unresolved = await startAgent("unresolved-project-review", null, null);
  await internal("review-start", { agentId: "unresolved-project-review", trigger: "idle" });
  const denied = await unresolved.call("memory_save", {
    title: "No project",
    content: "Cannot assign this scope",
  });
  expect(denied.structuredContent?.error.code).toBe("scope_denied");
  expect(service.store.reviews.info(unresolved.nonce)).toMatchObject({ attempts: 1, committed: 0 });
});
