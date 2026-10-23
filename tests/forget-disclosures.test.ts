import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { openDatabase } from "../service/sqlite";
import { MemoryStore } from "../service/store";
import { ForgetPreviewSchema, MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, type ProjectRef, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, owner, tempDir } from "./helpers";

let service: RunningService | undefined;
let store: MemoryStore | undefined;
afterEach(async () => {
  await service?.stop();
  store?.close();
  service = undefined;
  store = undefined;
});
function running(): RunningService {
  if (!service) throw new Error("Service was not started");
  return service;
}
async function internal(route: string, body: unknown) {
  const live = running();
  const response = await fetch(`http://127.0.0.1:${live.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(live.secret) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
const toolResult = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z.object({ error: z.object({ code: z.string() }) }).optional(),
  }),
});
async function tool(input: { name: string; args: unknown; nonce: string; project?: ProjectRef }) {
  const live = running();
  const response = await fetch(live.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(live.secret, {
        nonce: input.nonce,
        agentId: `agent-${input.nonce}`,
        provider: null,
        projectKey: (input.project ?? dataRepo).key,
      }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mutationRequestId(),
      method: "tools/call",
      params: { name: input.name, arguments: input.args },
    }),
  });
  expect(response.status).toBe(200);
  const result = toolResult.parse(await response.json()).result;
  return { ...result, text: result.content.map((part) => part.text).join("\n") };
}
async function capture(nonce: string, text: string, project = dataRepo) {
  const response = await internal("record-turn", {
    agentId: `agent-${nonce}`,
    project,
    provider: null,
    title: "Isolated diagnostic",
    workspaceDir: null,
    userText: "Synthetic diagnostic task",
    assistantText: text,
    files: [],
  });
  expect(response).toEqual({ status: 200, body: { ok: true, recorded: true } });
}
async function create(title: string, project = dataRepo) {
  const result = await internal("mutate", {
    requestId: mutationRequestId(),
    operation: "create",
    change: { title, content: `${title} isolated fact`, scope: "project", project },
  });
  expect(result.status).toBe(200);
  return MutationResultSchema.parse(result.body);
}

async function disclosureFixture() {
  service = await startService({
    dataDir: tempDir("pm-forget-api-"),
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
  service.store.upsertProject(dataRepo);
  service.store.upsertProject(otherRepo);
  service.store.configure({
    ...DEFAULT_RUNTIME,
    maxPinned: 0,
    projectMemories: 0,
    globalMemories: 0,
    recentSessions: 3,
  });
  const root = await create("Synthetic source");
  const unrelated = await create("Unrelated protected source", otherRepo);
  const alice = await tool({ name: "memory_get", args: { ids: [root.memoryRef.id] }, nonce: "alice" });
  expect(alice.text).toContain("Synthetic source isolated fact");
  await capture("alice", "Synthetic source isolated fact");
  const bob = await tool({ name: "memory_context", args: {}, nonce: "bob" });
  expect(bob.text).toContain("Synthetic source isolated fact");
  await capture("bob", "Synthetic source isolated fact");
  await tool({ name: "memory_get", args: { ids: [unrelated.memoryRef.id] }, nonce: "dave" });
  await capture("dave", "Independent diagnostic context");
  const foreign = await tool({
    name: "memory_get",
    args: { ids: [root.memoryRef.id] },
    nonce: "eve",
    project: otherRepo,
  });
  expect(foreign.text).not.toContain("Synthetic source isolated fact");
  await capture("eve", "Other project context", otherRepo);
  return { root, unrelated };
}

it("forgets Alice-to-Bob digest disclosures without erasing unrelated or unauthorized contexts", async () => {
  const { root, unrelated } = await disclosureFixture();
  const service = running();
  const forbidden = await tool({
    name: "memory_mutate",
    args: {
      requestId: "forbidden-forget",
      operation: "forget",
      id: unrelated.memoryRef.id,
      expectedRevision: 1,
    },
    nonce: "bob",
  });
  expect(forbidden.isError).toBe(true);
  expect(
    service.store
      .getVisible(owner, [root.memoryRef.id, unrelated.memoryRef.id])
      .map((row) => row.id)
      .sort((a, b) => a - b),
  ).toEqual([root.memoryRef.id, unrelated.memoryRef.id].sort((a, b) => a - b));
  const preview = ForgetPreviewSchema.parse(
    (await internal("forget-preview", { id: root.memoryRef.id })).body,
  );
  expect(new Set(preview.affectedAgentIds)).toEqual(new Set(["agent-alice", "agent-bob"]));
  const forgotten = await internal("mutate", {
    requestId: "forget-diagnostic",
    operation: "forget",
    id: root.memoryRef.id,
    expectedRevision: root.memoryRef.revision,
  });
  expect(forgotten.status).toBe(200);
  expect(
    service.store.sessions({ projectKey: dataRepo.key, query: "", limit: 20 }).map((row) => row.agent_id),
  ).toEqual(["agent-dave"]);
  expect(
    service.store.sessions({ projectKey: otherRepo.key, query: "", limit: 20 }).map((row) => row.agent_id),
  ).toEqual(["agent-eve"]);
  for (const name of ["memory_get", "memory_save"]) {
    const denied = await tool({
      name,
      args:
        name === "memory_get"
          ? { ids: [unrelated.memoryRef.id] }
          : { title: "Copied forgotten source", content: "Synthetic source isolated fact", scope: "project" },
      nonce: "bob",
    });
    expect(denied.structuredContent?.error.code).toBe("context_invalidated");
  }
  expect(
    (
      await internal("record-turn", {
        agentId: "agent-bob",
        project: dataRepo,
        provider: null,
        title: null,
        workspaceDir: null,
        userText: "Retry",
        assistantText: "Synthetic source isolated fact",
        files: [],
      })
    ).body,
  ).toEqual({ ok: true, recorded: false });
  const dave = await tool({
    name: "memory_save",
    args: { title: "Independent new fact", content: "Unrelated diagnostic claim", scope: "project" },
    nonce: "dave",
  });
  expect(dave.isError).not.toBe(true);
  const fresh = await tool({
    name: "memory_save",
    args: { title: "Fresh authorized context", content: "New diagnostic assertion", scope: "project" },
    nonce: "fresh",
  });
  expect(MutationResultSchema.parse(JSON.parse(fresh.text)).state).toBe("candidate");
  expect(service.store.getVisible(owner, [unrelated.memoryRef.id]).map((row) => row.title)).toEqual([
    "Unrelated protected source",
  ]);
});

function fixture(agentId?: string) {
  const path = join(tempDir("pm-forget-graph-"), "memory.db");
  store = new MemoryStore({ path });
  const root = store.mutations.mutate(
    { ...ownerMutation(owner), agentId },
    {
      requestId: "root",
      operation: "create",
      change: { title: "Graph source", content: "Synthetic bounded graph", scope: "global" },
    },
  );
  return { path, root, current: store };
}
function insertChainNode(db: Database, i: number, rootId: number): void {
  const at = "2026-10-01T00:00:00.000Z";
  db.query("INSERT INTO agent_links(nonce,agent_id,created_at) VALUES(?,?,?)").run(
    `nonce-${i}`,
    `agent-${i}`,
    at,
  );
  db.query("INSERT INTO sessions(id,agent_id,started_at,updated_at) VALUES(?,?,?,?)").run(
    `agent-${i}`,
    `agent-${i}`,
    at,
    at,
  );
  const kind = i === 0 ? "get" : i % 3 === 0 ? "inject" : i % 3 === 1 ? "context" : "search";
  const detail =
    i === 0
      ? { found: [rootId] }
      : kind === "search"
        ? { results: [{ id: `session:agent-${i - 1}`, score: 1 }] }
        : { sessions: [`agent-${i - 1}`] };
  db.query("INSERT INTO audit_events(nonce,kind,detail,created_at) VALUES(?,?,?,?)").run(
    `nonce-${i}`,
    kind,
    JSON.stringify(detail),
    at,
  );
}

it("traverses deep cyclic inject/context/search disclosure graphs and revokes late-linked callers", () => {
  const { path, root, current } = fixture();
  const { db } = openDatabase(path);
  const count = 180;
  try {
    db.transaction(() => {
      for (let i = 0; i < count; i++) insertChainNode(db, i, root.memoryRef.id);
      db.query("INSERT INTO audit_events(nonce,kind,detail,created_at) VALUES(?,?,?,?)").run(
        "nonce-0",
        "context",
        JSON.stringify({ sessions: [`agent-${count - 1}`] }),
        "2026-10-01T00:00:00.000Z",
      );
      db.query("INSERT INTO audit_events(nonce,kind,detail,created_at) VALUES(?,?,?,?)").run(
        "unbound-reader",
        "context",
        JSON.stringify({ sessions: [`agent-${count - 1}`] }),
        "2026-10-01T00:00:00.000Z",
      );
    })();
    const preview = current.lifecycle.preview(owner, root.memoryRef.id);
    expect(new Set(preview.affectedAgentIds)).toEqual(
      new Set(Array.from({ length: count }, (_, i) => `agent-${i}`)),
    );
    current.mutations.mutate(ownerMutation(owner), {
      requestId: "forget-cycle",
      operation: "forget",
      id: root.memoryRef.id,
      expectedRevision: 1,
    });
    expect(current.sessions({ projectKey: null, query: "", limit: 200 })).toEqual([]);
    for (const i of [0, 90, 179]) expect(current.sessionInvalidated(`agent-${i}`)).toBe(true);
    current.audit.link({ nonce: "unbound-reader", agentId: "late-agent", workspaceId: null, title: null });
    expect(current.sessionInvalidated("late-agent")).toBe(true);
  } finally {
    db.close();
  }
});
it("retains canonical session exposure after source digest and caller-link pruning", () => {
  const { path, root, current } = fixture("agent-0");
  const { db } = openDatabase(path);
  try {
    db.transaction(() => {
      insertChainNode(db, 0, root.memoryRef.id);
      insertChainNode(db, 1, root.memoryRef.id);
      db.query("DELETE FROM sessions WHERE id='agent-0'").run();
      db.query("DELETE FROM audit_events WHERE nonce='nonce-0'").run();
      db.query("DELETE FROM agent_links WHERE nonce='nonce-0'").run();
    })();
    expect(new Set(current.lifecycle.preview(owner, root.memoryRef.id).affectedAgentIds)).toEqual(
      new Set(["agent-0", "agent-1"]),
    );
    current.mutations.mutate(ownerMutation(owner), {
      requestId: "forget-pruned",
      operation: "forget",
      id: root.memoryRef.id,
      expectedRevision: 1,
    });
    expect(current.sessionInvalidated("agent-1")).toBe(true);
    expect(current.sessions({ projectKey: null, query: "", limit: 10 })).toEqual([]);
  } finally {
    db.close();
  }
});

it("fails closed at the context graph ceiling without partial erasure", () => {
  const { path, root, current } = fixture();
  const { db } = openDatabase(path);
  try {
    db.transaction(() => {
      const insert = db.query("INSERT INTO audit_events(nonce,kind,detail,created_at) VALUES(?,'get',?,?)");
      for (let i = 0; i < 10001; i++)
        insert.run(`reader-${i}`, JSON.stringify({ found: [root.memoryRef.id] }), "2026-10-01T00:00:00.000Z");
    })();
    expect(() => current.lifecycle.preview(owner, root.memoryRef.id)).toThrow("10000");
    expect(() =>
      current.mutations.mutate(ownerMutation(owner), {
        requestId: "over-bound",
        operation: "forget",
        id: root.memoryRef.id,
        expectedRevision: 1,
      }),
    ).toThrow("10000");
    expect(current.getVisible(owner, [root.memoryRef.id]).map((row) => row.title)).toEqual(["Graph source"]);
    expect(db.query("SELECT count(*) AS n FROM memory_tombstones").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 10001 });
  } finally {
    db.close();
  }
});
