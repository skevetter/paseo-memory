import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import type { Caller, ToolOutput } from "../service/mcp";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { MemoryStore } from "../service/store";
import { createTools } from "../service/tools";
import { MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, MAX_CONTENT_CHARS, SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder, hashSpec, owner, tempDir } from "./helpers";

function parseMutationReceipt(output: string | ToolOutput) {
  return MutationResultSchema.parse(JSON.parse(typeof output === "string" ? output : output.text));
}

const resultSchema = z.object({
  result: z.object({
    isError: z.boolean(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z
      .object({ error: z.object({ code: z.string() }).optional() })
      .passthrough()
      .optional(),
  }),
});
type ToolResult = z.infer<typeof resultSchema>["result"];
let service: RunningService;
let headers: Record<string, string>;
let requestId = 0;
beforeEach(async () => {
  service = await startService({
    dataDir: tempDir("pm-review-cap-"),
    port: 0,
    tier: "zero",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
  const context = z
    .object({ nonce: z.string(), mcpServer: z.object({ headers: z.record(z.string(), z.string()) }) })
    .parse(
      await internal("agent-context", {
        project: null,
        provider: "omp",
        includeContext: false,
        includeTools: true,
      }),
    );
  headers = context.mcpServer.headers;
  await internal("link-agent", {
    nonce: context.nonce,
    agentId: "reviewer",
    workspaceId: "workspace",
    title: "Review",
  });
  requestId = 0;
});
afterEach(() => service.stop());
async function internal(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
async function begin(cap: number) {
  service.store.configure({ ...DEFAULT_RUNTIME, reviewMaxMemories: cap });
  expect(await internal("review-start", { agentId: "reviewer", trigger: "idle" })).toMatchObject({
    ok: true,
    cap,
  });
}
async function call(name: string, args: unknown, id = ++requestId): Promise<ToolResult> {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return resultSchema.parse(await response.json()).result;
}
const save = (title: string) => ({
  title,
  content: `durable fact about ${title}`,
  scope: "global",
  force: true,
});
function receipt(result: ToolResult) {
  expect(result.isError).toBe(false);
  return MutationResultSchema.parse(JSON.parse(result.content[0]?.text ?? "null"));
}
function current(id: number) {
  const detail = service.store.lifecycleDetail(owner, id);
  return detail?.revisions.find((r) => r.revision === detail.memoryRef.revision)?.snapshot;
}
async function seed() {
  return Number(
    (
      await service.store.save({
        title: "Existing",
        content: "before",
        type: "note",
        scope: "global",
        project: null,
      })
    ).id,
  );
}

describe("atomic review mutation limits over MCP", () => {
  it("counts direct corrections and topic creations against the same cap without promoting them", async () => {
    const id = await seed();
    await begin(2);
    const updated = receipt(await call("memory_update", { id, content: "after" }));
    const created = receipt(await call("memory_save", { ...save("Topic"), topic_key: "topic" }));
    expect(updated).toMatchObject({ status: "updated", state: "candidate" });
    expect(created.state).toBe("candidate");
    expect(
      (await call("memory_save", { ...save("Topic"), content: "over cap", topic_key: "topic" }))
        .structuredContent?.error?.code,
    ).toBe("review_cap_reached");
    expect(current(id)?.content).toBe("after");
    expect(current(created.memoryRef.id)?.content).toBe("durable fact about Topic");
    expect(service.store.getVisible(owner, [id, created.memoryRef.id])).toEqual([]);
  });

  it("counts a topic correction once and preserves its identity", async () => {
    const original = await service.store.save({
      title: "Topic",
      content: "before",
      type: "note",
      scope: "global",
      project: null,
      topicKey: "topic",
    });
    await begin(1);
    const result = receipt(await call("memory_save", { ...save("Topic"), topic_key: "topic" }));
    expect(result.memoryRef).toEqual({ id: Number(original.id), revision: 2 });
    expect(
      (await call("memory_update", { id: original.id, content: "third" })).structuredContent?.error?.code,
    ).toBe("review_cap_reached");
    expect(current(Number(original.id))?.content).toBe("durable fact about Topic");
  });

  it("permits no memory changes at cap zero", async () => {
    const id = await seed();
    await begin(0);
    expect((await call("memory_save", save("Blocked"))).structuredContent?.error?.code).toBe(
      "review_cap_reached",
    );
    expect(
      (await call("memory_update", { id, content: "must not persist" })).structuredContent?.error?.code,
    ).toBe("review_cap_reached");
    expect(current(id)).toMatchObject({ content: "before", record_revision: 1 });
  });

  it("accepts only N of N+1 concurrent writes and replays duplicates after exhaustion", async () => {
    await begin(2);
    const args = [save("Concurrent A"), save("Concurrent B"), save("Concurrent C")];
    const results = await Promise.all(args.map((value, i) => call("memory_save", value, 100 + i)));
    expect(results.map((r) => r.isError).filter(Boolean)).toEqual([true]);
    const accepted = results.flatMap((r, i) =>
      r.isError ? [] : [{ value: receipt(r), index: i, result: r }],
    );
    expect(service.store.stats().memories).toBe(2);
    for (const item of accepted)
      expect(current(item.value.memoryRef.id)?.title).toBe(args[item.index]?.title);
    for (const item of accepted)
      expect(await call("memory_save", args[item.index], 100 + item.index)).toEqual(item.result);
    expect((await call("memory_save", save("Unrelated"), 200)).structuredContent?.error?.code).toBe(
      "review_cap_reached",
    );
  });

  it("deduplicates simultaneous identical requests without a second mutation slot", async () => {
    await begin(1);
    const results = await Promise.all([
      call("memory_save", save("Idempotent"), 99),
      call("memory_save", save("Idempotent"), 99),
    ]);
    expect(results[0]).toEqual(results[1]);
    const saved = receipt(results[0] as ToolResult);
    expect(current(saved.memoryRef.id)).toMatchObject({ title: "Idempotent", record_revision: 1 });
    expect((await call("memory_save", save("Unrelated"), 100)).structuredContent?.error?.code).toBe(
      "review_cap_reached",
    );
  });
});

describe("review attempts, no-ops and degraded models", () => {
  it("does not charge no-op, duplicate or failed mutations and still returns prior receipts", async () => {
    const id = await seed();
    await begin(1);
    const unchangedArgs = { id, content: "before" };
    const duplicateArgs = { title: "Existing", content: "before", scope: "global" };
    const unchanged = await call("memory_update", unchangedArgs, 71);
    const duplicate = await call("memory_save", duplicateArgs, 72);
    expect(receipt(unchanged).status).toBe("unchanged");
    expect(receipt(duplicate).status).toBe("duplicate");
    expect((await call("memory_update", { id, content: "x".repeat(MAX_CONTENT_CHARS + 1) })).isError).toBe(
      true,
    );
    const corrected = receipt(await call("memory_update", { id, content: "actual correction" }));
    expect(corrected.memoryRef.revision).toBe(2);
    expect(current(id)?.content).toBe("actual correction");
    expect((await call("memory_save", save("Over cap"))).structuredContent?.error?.code).toBe(
      "review_cap_reached",
    );
    expect(await call("memory_update", unchangedArgs, 71)).toEqual(unchanged);
    expect(await call("memory_save", duplicateArgs, 72)).toEqual(duplicate);
  });

  it("bounds failed and malformed attempts independently of successful changes", async () => {
    await begin(1);
    for (let i = 0; i < 10; i++) {
      expect((await call("memory_update", { id: 99999, content: "missing" })).isError).toBe(true);
      expect((await call("memory_save", { title: "Missing content" })).isError).toBe(true);
    }
    expect((await call("memory_save", save("Too many attempts"))).structuredContent?.error?.code).toBe(
      "review_attempt_limit",
    );
    expect(service.store.stats().memories).toBe(0);
  });

  it("retains a durable candidate through model outage and serves lexical recall only after approval", async () => {
    await begin(1);
    service.store.setEmbedder({
      spec: hashSpec("test/failed", 4),
      embed: async () => {
        throw new Error("offline");
      },
    });
    const candidate = receipt(await call("memory_save", save("Lexical fallback")));
    expect((await call("memory_save", save("Over cap"))).isError).toBe(true);
    expect(await service.store.search({ access: owner, query: "Lexical fallback" })).toEqual([]);
    service.store.mutations.mutate(ownerMutation(owner), {
      requestId: mutationRequestId(),
      operation: "promote",
      id: candidate.memoryRef.id,
      expectedRevision: candidate.memoryRef.revision,
    });
    await service.store.indexPending();
    expect(
      (await service.store.search({ access: owner, query: "Lexical fallback" })).map((hit) => hit.title),
    ).toEqual(["Lexical fallback"]);
  });
});

describe("persisted review capabilities", () => {
  it("keeps expiry closed through restart until an explicit task lifecycle transition", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const path = join(tempDir("pm-review-expiry-"), "memory.db");
    let store = new MemoryStore({ path, now: () => now, log: silentLogger });
    const caller: Caller = { nonce: "nonce", agentId: "agent", projectKey: null, provider: "omp" };
    const invoke = (id: string) => {
      const tool = createTools({ store, resolveProject: () => null }).find(
        (item) => item.name === "memory_save",
      );
      if (!tool) throw new Error("missing save");
      return tool.handler(save("Late"), caller, { id });
    };
    try {
      store.reviews.open({ agentId: "agent", nonce: "nonce", trigger: "idle", cap: 1 });
      now = new Date("2026-01-03T00:00:00Z");
      await expect(invoke("late")).rejects.toMatchObject({ code: "review_closed" });
      store.close();
      store = new MemoryStore({ path, now: () => now, log: silentLogger });
      await expect(invoke("restart")).rejects.toMatchObject({ code: "review_closed" });
      store.reviews.close("agent");
      const result = parseMutationReceipt(await invoke("after-end"));
      expect(store.lifecycleDetail(owner, result.memoryRef.id)?.state).toBe("candidate");
    } finally {
      store.close();
    }
  });

  it("retains committed cap usage and exact receipts through restart", async () => {
    const path = join(tempDir("pm-review-restart-"), "memory.db");
    let store = new MemoryStore({ path, log: silentLogger });
    const caller: Caller = { nonce: "nonce", agentId: "agent", projectKey: null, provider: "omp" };
    const invoke = (id: string) => {
      const tool = createTools({ store, resolveProject: () => null }).find(
        (item) => item.name === "memory_save",
      );
      if (!tool) throw new Error("missing save");
      return tool.handler(save("Retained"), caller, { id });
    };
    try {
      store.reviews.open({ agentId: "agent", nonce: "nonce", trigger: "idle", cap: 1 });
      const original = await invoke("original");
      const result = parseMutationReceipt(original);
      store.close();
      store = new MemoryStore({ path, log: silentLogger });
      expect(await invoke("original")).toBe(original);
      await expect(invoke("new-request")).rejects.toMatchObject({ code: "review_cap_reached" });
      expect(store.lifecycleDetail(owner, result.memoryRef.id)?.revisions[0]?.snapshot.title).toBe(
        "Retained",
      );
    } finally {
      store.close();
    }
  });

  it("fences reservations when a review ends and a new window starts", () => {
    const store = new MemoryStore({ path: ":memory:", log: silentLogger });
    try {
      const input = { agentId: "agent", nonce: "nonce", trigger: "idle", cap: 1 };
      store.reviews.open(input);
      const old = store.reviews.admit("nonce", "same-request", "save");
      if (old.kind !== "granted") throw new Error("missing reservation");
      store.reviews.close("agent");
      store.reviews.open(input);
      const current = store.reviews.admit("nonce", "same-request", "save");
      if (current.kind !== "granted") throw new Error("missing reservation");
      const mutation = {
        requestId: "same-request",
        operation: "create" as const,
        change: { title: "Current", content: "new review" },
      };
      expect(() => store.mutations.mutate(ownerMutation(owner), mutation, old.reservation)).toThrow();
      expect(store.reviews.info("nonce")?.reserved).toBe(1);
      const accepted = store.mutations.mutate(ownerMutation(owner), mutation, current.reservation);
      expect(store.getVisible(owner, [accepted.memoryRef.id])[0]?.content).toBe("new review");
    } finally {
      store.close();
    }
  });
});
