import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import type { Embedder } from "../service/embedder";
import type { Caller, ToolDefinition } from "../service/mcp";
import { MemoryStore } from "../service/store";
import { createTools } from "../service/tools";
import { silentLogger } from "../shared/log";
import { DEFAULT_RUNTIME, MAX_CONTENT_CHARS, SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder, hashSpec, owner, tempDir } from "./helpers";

const resultSchema = z.object({
  result: z.object({
    isError: z.boolean(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z.object({ error: z.object({ code: z.string() }) }).optional(),
  }),
});

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
  const context = await internal("agent-context", {
    project: null,
    provider: "omp",
    includeContext: false,
    includeTools: true,
  });
  const parsed = z
    .object({ nonce: z.string(), mcpServer: z.object({ headers: z.record(z.string(), z.string()) }) })
    .parse(context);
  headers = parsed.mcpServer.headers;
  await internal("link-agent", {
    nonce: parsed.nonce,
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
async function call(name: string, args: unknown, id = ++requestId) {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return resultSchema.parse(await response.json()).result;
}
const save = (label: string) => ({
  title: label,
  content: `durable fact about ${label}`,
  scope: "global",
  force: true,
});
const text = (result: z.infer<typeof resultSchema>["result"]) => result.content[0]?.text ?? "";
const seed = async () =>
  Number(
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

class DeferredEmbedding {
  readonly entered = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  readonly backend = hashEmbedder();
  private waiting = true;
  readonly embedder: Embedder = {
    spec: this.backend.spec,
    embed: async (texts, kind) => {
      if (this.waiting) {
        this.waiting = false;
        this.entered.resolve();
        await this.released.promise;
      }
      return this.backend.embed(texts, kind);
    },
  };
}

describe("atomic review limits over MCP", () => {
  it("counts direct updates and topic upserts against the same save cap", async () => {
    const id = await seed();
    await begin(2);
    expect((await call("memory_update", { id, content: "after" })).isError).toBe(false);
    expect(text(await call("memory_save", { ...save("Topic"), topic_key: "topic" }))).toStartWith("created:");
    expect(
      (await call("memory_save", { ...save("Topic"), content: "new topic value", topic_key: "topic" }))
        .isError,
    ).toBe(true);
    expect(service.store.getVisible(owner, [id])[0]?.content).toBe("after");
    expect(service.store.liveRows(owner).find((row) => row.topic_key === "topic")?.content).toBe(
      "durable fact about Topic",
    );
  });

  it("counts a successful topic upsert as one change", async () => {
    const original = await service.store.save({
      title: "Topic",
      content: "before",
      type: "note",
      scope: "global",
      project: null,
      topicKey: "topic",
    });
    await begin(1);
    expect(text(await call("memory_save", { ...save("Topic"), topic_key: "topic" }))).toBe(
      `updated: #${original.id} (global)`,
    );
    expect((await call("memory_update", { id: original.id, content: "third value" })).isError).toBe(true);
    expect(service.store.getVisible(owner, [Number(original.id)])[0]?.content).toBe(
      "durable fact about Topic",
    );
  });

  it("cap zero blocks both saves and updates", async () => {
    const id = await seed();
    await begin(0);
    expect((await call("memory_save", save("Blocked"))).isError).toBe(true);
    expect((await call("memory_update", { id, content: "must not persist" })).isError).toBe(true);
    expect(service.store.getVisible(owner, [id])[0]?.content).toBe("before");
    expect(service.store.liveRows(owner).map((row) => row.id)).toEqual([id]);
  });

  it("reserves the last slot before embedding so N+1 concurrent calls cannot exceed N", async () => {
    await begin(1);
    const deferred = new DeferredEmbedding();
    service.store.setEmbedder(deferred.embedder);
    const first = call("memory_save", save("Admitted"));
    await deferred.entered.promise;
    try {
      const rest = await Promise.all([
        call("memory_save", save("Denied")),
        call("memory_save", save("Also denied")),
      ]);
      expect(rest.map((result) => result.isError)).toEqual([true, true]);
    } finally {
      deferred.released.resolve();
    }
    expect(text(await first)).toStartWith("created:");
    expect(service.store.liveRows(owner).map((row) => row.title)).toEqual(["Admitted"]);
  });

  it("replays an in-flight request and its receipt after the cap is exhausted", async () => {
    await begin(1);
    const deferred = new DeferredEmbedding();
    service.store.setEmbedder(deferred.embedder);
    const first = call("memory_save", save("Idempotent"), 99);
    await deferred.entered.promise;
    const retry = call("memory_save", save("Idempotent"), 99);
    deferred.released.resolve();
    expect(await retry).toEqual(await first);
    expect(await call("memory_save", save("Idempotent"), 99)).toEqual(await first);
    expect((await call("memory_save", save("Unrelated"), 100)).isError).toBe(true);
    expect(service.store.liveRows(owner).map((row) => row.title)).toEqual(["Idempotent"]);
  });
});

describe("review retry and attempt accounting over MCP", () => {
  it("does not charge unchanged updates, duplicate saves or failed writes", async () => {
    const id = await seed();
    await begin(1);
    const unchangedArgs = { id, content: "before" };
    const duplicateArgs = { title: "Existing", content: "before", scope: "global" };
    const unchanged = await call("memory_update", unchangedArgs, 71);
    const duplicate = await call("memory_save", duplicateArgs, 72);
    expect(text(unchanged)).toStartWith("unchanged:");
    expect(text(duplicate)).toStartWith("duplicate:");
    expect((await call("memory_update", { id, content: "x".repeat(MAX_CONTENT_CHARS + 1) })).isError).toBe(
      true,
    );
    expect(text(await call("memory_update", { id, content: "actual correction" }))).toBe(`updated: #${id}`);
    expect(service.store.getVisible(owner, [id])[0]).toMatchObject({
      content: "actual correction",
      revision_count: 2,
    });
    expect((await call("memory_save", save("Over cap"))).isError).toBe(true);
    expect(await call("memory_update", unchangedArgs, 71)).toEqual(unchanged);
    expect(await call("memory_save", duplicateArgs, 72)).toEqual(duplicate);
    expect(service.store.getVisible(owner, [id])[0]?.content).toBe("actual correction");
  });

  it("bounds failed and malformed attempts independently of successful changes", async () => {
    await begin(1);
    for (let i = 0; i < 10; i++) {
      expect(text(await call("memory_update", { id: 99999, content: "missing" }))).toStartWith("not found:");
      expect((await call("memory_save", { title: "Missing content" })).isError).toBe(true);
    }
    const denied = await call("memory_save", save("Too many attempts"));
    expect(denied.structuredContent?.error.code).toBe("review_attempt_limit");
    expect(service.store.liveRows(owner)).toEqual([]);
  });

  it("counts a durable lexical save even when embedding fails", async () => {
    await begin(1);
    service.store.setEmbedder({
      spec: hashSpec("test/failed", 4),
      embed: async () => {
        throw new Error("offline");
      },
    });
    expect(text(await call("memory_save", save("Lexical fallback")))).toStartWith("created:");
    expect((await call("memory_save", save("Over cap"))).isError).toBe(true);
    expect(service.store.liveRows(owner).map((row) => row.title)).toEqual(["Lexical fallback"]);
    expect(
      (await service.store.search({ access: owner, query: "Lexical fallback" })).map((hit) => hit.title),
    ).toEqual(["Lexical fallback"]);
  });
});

describe("persisted review capability", () => {
  it("blocks expired and late-prepared writes until explicit review end, including after restart", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const path = join(tempDir("pm-review-expiry-"), "memory.db");
    let store = new MemoryStore({ path, now: () => now, log: silentLogger });
    const caller: Caller = { nonce: "nonce", agentId: "agent", projectKey: null, provider: "omp" };
    const tools = (target: MemoryStore) => createTools({ store: target, resolveProject: () => null });
    const invoke = (definitions: ToolDefinition[], id: string) => {
      const tool = definitions.find((item) => item.name === "memory_save");
      if (!tool) throw new Error("missing save");
      return tool.handler(save("Late"), caller, { id });
    };
    try {
      store.reviews.open({ agentId: "agent", nonce: "nonce", trigger: "idle", cap: 1 });
      const deferred = new DeferredEmbedding();
      store.setEmbedder(deferred.embedder);
      const pending = invoke(tools(store), "late");
      await deferred.entered.promise;
      now = new Date("2026-01-03T00:00:00Z");
      deferred.released.resolve();
      await expect(pending).rejects.toMatchObject({ code: "review_closed" });
      expect(store.liveRows(owner)).toEqual([]);
      store.close();
      store = new MemoryStore({ path, now: () => now, log: silentLogger });
      await expect(invoke(tools(store), "restart")).rejects.toMatchObject({ code: "review_closed" });
      store.reviews.close("agent");
      expect(await invoke(tools(store), "after-end")).toStartWith("created:");
    } finally {
      store.close();
    }
  });

  it("retains committed cap usage and receipts through restart", async () => {
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
      const receipt = await invoke("original");
      store.close();
      store = new MemoryStore({ path, log: silentLogger });
      expect(await invoke("original")).toBe(receipt);
      await expect(invoke("new-request")).rejects.toMatchObject({ code: "review_cap_reached" });
      expect(store.liveRows(owner).map((row) => row.title)).toEqual(["Retained"]);
    } finally {
      store.close();
    }
  });

  it("cannot carry a prepared write across review end and a new review on the same agent", async () => {
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
      await expect(
        store.save(
          { title: "Obsolete", content: "old review", scope: "global", project: null, type: "note" },
          old.reservation,
        ),
      ).rejects.toMatchObject({ code: "review_closed" });
      expect(store.reviews.info("nonce")?.reserved).toBe(1);
      await store.save(
        { title: "Current", content: "new review", scope: "global", project: null, type: "note" },
        current.reservation,
      );
      expect(store.liveRows(owner).map((row) => row.title)).toEqual(["Current"]);
    } finally {
      store.close();
    }
  });
});
