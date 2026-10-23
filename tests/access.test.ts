import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { Access } from "../service/access";
import { type RunningService, serviceKey, startService } from "../service/app";
import { MemoryStore } from "../service/store";
import { silentLogger } from "../shared/log";
import { AgentAuditSchema, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, owner, tempDir } from "./helpers";

let service: RunningService;
beforeAll(async () => {
  service = await startService({
    dataDir: tempDir("pm-access-"),
    port: 0,
    tier: "zero",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
});
afterAll(() => service.stop());

const ToolResult = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    isError: z.boolean(),
    structuredContent: z.object({ error: z.object({ code: z.string(), message: z.string() }) }).optional(),
  }),
});

async function internal(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  return z.record(z.string(), z.unknown()).parse(await response.json());
}

async function rpc(headers: Record<string, string>, name: string, args: unknown) {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ToolResult.parse(await response.json()).result;
}

async function agent(project: typeof dataRepo | null) {
  const created = await internal("agent-context", {
    project,
    provider: "omp",
    includeContext: false,
    includeTools: true,
  });
  const parsed = z
    .object({ nonce: z.string(), mcpServer: z.object({ headers: z.record(z.string(), z.string()) }) })
    .parse(created);
  const call = (name: string, args: unknown) => rpc(parsed.mcpServer.headers, name, args);
  return { nonce: parsed.nonce, call };
}

async function seed(title: string, scope: "global" | "project", project: typeof dataRepo | null) {
  const result = await service.store.save({
    title,
    content: `kiwi marker for ${title}`,
    type: "note",
    scope,
    project,
    force: true,
  });
  return Number(result.id);
}

const ids = { a: 0, b: 0, global: 0 };
beforeAll(async () => {
  ids.a = await seed("Alpha project secret", "project", dataRepo);
  ids.b = await seed("Beta project secret", "project", otherRepo);
  ids.global = await seed("Global shared note", "global", null);
  await service.store.indexPending();
});

const found = (text: string) => ({
  alpha: text.includes("Alpha project secret"),
  beta: text.includes("Beta project secret"),
  global: text.includes("Global shared note"),
});

describe("scope=all follows the signed project", () => {
  it("returns only global memory when the project could not be resolved", async () => {
    const lost = await agent(null);
    const all = (await lost.call("memory_search", { query: "kiwi marker" })).content[0]?.text ?? "";
    expect(found(all)).toEqual({ alpha: false, beta: false, global: true });
    const empty = (await lost.call("memory_search", { query: "" })).content[0]?.text ?? "";
    expect(found(empty)).toEqual({ alpha: false, beta: false, global: true });
    const short = (await lost.call("memory_search", { query: "ki" })).content[0]?.text ?? "";
    expect(found(short).alpha || found(short).beta).toBe(false);
  });

  it("returns the granted project and global memory but never another project", async () => {
    const inA = await agent(dataRepo);
    const text = (await inA.call("memory_search", { query: "kiwi marker" })).content[0]?.text ?? "";
    expect(found(text)).toEqual({ alpha: true, beta: false, global: true });
    const onlyProject = (await inA.call("memory_search", { query: "kiwi marker", scope: "project" }))
      .content[0]?.text;
    expect(found(onlyProject ?? "")).toEqual({ alpha: true, beta: false, global: false });
  });

  it("applies the same grant to session previews", async () => {
    for (const [agentId, project] of [
      ["session-a", dataRepo],
      ["session-b", otherRepo],
    ] as const) {
      await internal("record-turn", {
        agentId,
        project,
        provider: "omp",
        title: `walrus session ${agentId}`,
        workspaceDir: null,
        userText: "walrus question",
        assistantText: "walrus answer that is long enough to count as a usable reply",
        files: [],
      });
    }
    const lost = await agent(null);
    const none = await lost.call("memory_search", { query: "walrus", include_sessions: true });
    expect(none.content[0]?.text).toBe("No matching memories.");
    const inA = await agent(dataRepo);
    const text = (await inA.call("memory_search", { query: "walrus", include_sessions: true })).content[0]
      ?.text;
    expect(text).toContain("session:session-a");
    expect(text).not.toContain("session:session-b");
  });
});

describe("id based tools", () => {
  it("hides, refuses to edit and refuses to delete a memory of another project", async () => {
    const inA = await agent(dataRepo);
    expect((await inA.call("memory_get", { ids: [ids.b] })).content[0]?.text).toBe(
      "No memories found for those ids.",
    );
    const update = await inA.call("memory_update", { id: ids.b, title: "Hijacked" });
    expect(update.content[0]?.text).toBe(`not found: #${ids.b}`);
    expect((await inA.call("memory_delete", { id: ids.b })).content[0]?.text).toBe(`not found: #${ids.b}`);
    const detail = z
      .object({ memory: z.object({ title: z.string() }).nullable() })
      .parse(await internal("detail", { id: ids.b }));
    expect(detail.memory?.title).toBe("Beta project secret");
  });

  it("lets a project-less agent reach only global memory by id", async () => {
    const lost = await agent(null);
    expect((await lost.call("memory_get", { ids: [ids.a, ids.global] })).content[0]?.text).toContain(
      "Global shared note",
    );
    expect((await lost.call("memory_get", { ids: [ids.a] })).content[0]?.text).toBe(
      "No memories found for those ids.",
    );
    expect((await lost.call("memory_delete", { id: ids.a })).content[0]?.text).toBe(`not found: #${ids.a}`);
  });

  it("does not reveal the target of a merge the caller cannot see", async () => {
    const source = await seed("Beta duplicate source", "project", otherRepo);
    const target = await seed("Beta duplicate target", "project", otherRepo);
    expect(await internal("merge", { sourceId: source, targetId: target })).toMatchObject({ ok: true });
    const inA = await agent(dataRepo);
    expect((await inA.call("memory_get", { ids: [source] })).content[0]?.text).toBe(
      "No memories found for those ids.",
    );
    const inB = await agent(otherRepo);
    expect((await inB.call("memory_get", { ids: [source] })).content[0]?.text).toContain(
      `merged into #${target}`,
    );
  });
});

describe("owner browsing", () => {
  it("keeps all-project search and the attachment picker working", async () => {
    const search = z
      .object({ items: z.array(z.object({ title: z.string() })) })
      .parse(
        await internal("search", { query: "kiwi marker", paseoProjectId: null, scope: "all", limit: 20 }),
      );
    const titles = search.items.map((i) => i.title);
    expect(titles).toContain("Alpha project secret");
    expect(titles).toContain("Beta project secret");
    expect(titles).toContain("Global shared note");
    const picked = z
      .object({ items: z.array(z.object({ title: z.string() })) })
      .parse(await internal("attachments", { query: "kiwi marker" }));
    expect(picked.items.map((i) => i.title)).toEqual(expect.arrayContaining([...titles]));
  });
});

describe("tool input validation", () => {
  const malformed: [string, string, unknown][] = [
    ["memory_search", "limit above the maximum", { query: "x", limit: 1000 }],
    ["memory_search", "fractional limit", { query: "x", limit: 2.5 }],
    ["memory_search", "string limit", { query: "x", limit: "5" }],
    ["memory_search", "unknown scope", { query: "x", scope: "everything" }],
    ["memory_search", "unknown type", { query: "x", type: "novel" }],
    ["memory_search", "missing query", {}],
    ["memory_search", "unknown property", { query: "x", project: "other" }],
    ["memory_get", "too many ids", { ids: Array.from({ length: 21 }, (_, i) => i + 1) }],
    ["memory_get", "non-integer id", { ids: [1.5] }],
    ["memory_get", "ids not an array", { ids: "1" }],
    ["memory_save", "unknown scope", { title: "t", content: "c", scope: "team" }],
    ["memory_save", "empty title", { title: "  ", content: "c" }],
    ["memory_save", "oversized title", { title: "t".repeat(201), content: "c" }],
    ["memory_save", "pinned as string", { title: "t", content: "c", pinned: "yes" }],
    ["memory_save", "unknown type", { title: "t", content: "c", type: "novel" }],
    ["memory_update", "string id", { id: "12", title: "x" }],
    ["memory_update", "no change requested", { id: 1 }],
    ["memory_delete", "negative id", { id: -3 }],
  ];

  it.each(malformed)("%s rejects %s without mutating anything", async (tool, _label, args) => {
    const inA = await agent(dataRepo);
    const count = service.store.stats().memories;
    const result = await inA.call(tool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("invalid_input");
    expect(result.content[0]?.text).toMatch(/^invalid_input: /);
    expect(service.store.stats().memories).toBe(count);
    expect(service.store.getVisible(owner, [ids.a, ids.b, ids.global]).map((r) => r.title)).toEqual([
      "Alpha project secret",
      "Beta project secret",
      "Global shared note",
    ]);
  });

  it("records denied scope and validation failures without request contents", async () => {
    const inA = await agent(dataRepo);
    await inA.call("memory_update", { id: ids.b, title: "SECRET-REQUEST-BODY" });
    await inA.call("memory_search", { query: "SECRET-QUERY-TEXT", limit: 1000 });
    await internal("link-agent", {
      nonce: inA.nonce,
      agentId: "agent-denied",
      workspaceId: null,
      title: null,
    });
    const audit = AgentAuditSchema.parse(await internal("agent-audit", { agentId: "agent-denied" }));
    expect(audit.events.map((e) => e.kind)).toEqual(["denied", "invalid"]);
    const serialized = JSON.stringify(audit.events);
    expect(serialized).not.toContain("SECRET-REQUEST-BODY");
    expect(serialized).not.toContain("SECRET-QUERY-TEXT");
  });
});

describe("store grants", () => {
  let store: MemoryStore;
  const memory = { a: 0, b: 0, global: 0 };

  beforeAll(async () => {
    store = new MemoryStore({ path: ":memory:" });
    store.setEmbedder(hashEmbedder("test/grants"));
    const save = async (title: string, scope: "global" | "project", project: typeof dataRepo | null) =>
      Number(
        (
          await store.save({
            title,
            content: `walnut pantry ${title}`,
            type: "note",
            scope,
            project,
            force: true,
          })
        ).id,
      );
    memory.a = await save("grant alpha", "project", dataRepo);
    memory.b = await save("grant beta", "project", otherRepo);
    memory.global = await save("grant global", "global", null);
    await store.indexPending();
  });
  afterAll(() => store.close());

  const titles = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

  it("grants a project-less agent global memory on lexical, vector and empty-query paths", async () => {
    const lost = Access.agent(null);
    expect(titles(await store.search({ query: "walnut pantry", access: lost }))).toEqual(["grant global"]);
    expect(titles(await store.search({ query: "walnut", access: lost, scope: "project" }))).toEqual([]);
    expect(titles(store.list({ access: lost }))).toEqual(["grant global"]);
    expect(store.liveRows(lost).map((r) => r.title)).toEqual(["grant global"]);
  });

  it("grants a project agent its project and global memory, and the owner everything", async () => {
    const inA = Access.agent(dataRepo.key);
    expect(titles(await store.search({ query: "walnut pantry", access: inA }))).toEqual([
      "grant alpha",
      "grant global",
    ]);
    expect(titles(await store.search({ query: "walnut pantry", access: owner }))).toEqual([
      "grant alpha",
      "grant beta",
      "grant global",
    ]);
    expect(
      titles(await store.search({ query: "walnut pantry", access: Access.owner(otherRepo.key) })),
    ).toEqual(["grant beta", "grant global"]);
  });

  it("refuses id based mutations outside the grant, including moves into a foreign project", () => {
    const inA = Access.agent(dataRepo.key);
    expect(store.getVisible(inA, [memory.a, memory.b, memory.global]).map((r) => r.id)).toEqual([
      memory.a,
      memory.global,
    ]);
    expect(store.deniedIds(inA, [memory.a, memory.b])).toEqual([memory.b]);
    expect(store.updateAuthorized(inA, memory.b, { title: "x" })).toBe("denied");
    expect(store.updateAuthorized(inA, memory.a, { scope: "project", project: otherRepo })).toBe("denied");
    expect(store.deleteAuthorized(inA, memory.b)).toBe("denied");
    expect(store.keep(inA, memory.b)).toBe("denied");
    expect(store.archive(inA, memory.b)).toBe("denied");
    expect(store.deleteAuthorized(inA, 987654)).toBe("not_found");
    expect(store.getVisible(owner, [memory.b])).toHaveLength(1);
  });

  it("lets only the owner restore and merge, and needs both ends authorized", () => {
    const inA = Access.agent(dataRepo.key);
    expect(store.restoreAuthorized(inA, memory.a, 1)).toBe("denied");
    expect(store.mergeAuthorized(inA, memory.a, memory.global)).toMatchObject({ ok: false });
    expect(store.getVisible(owner, [memory.a, memory.global])).toHaveLength(2);
  });

  it("shows a merge target only to callers who can read both ends", async () => {
    const save = async (title: string, project: typeof dataRepo) =>
      Number(
        (await store.save({ title, content: title, type: "note", scope: "project", project, force: true }))
          .id,
      );
    const source = await save("merge source", otherRepo);
    const target = await save("merge target", otherRepo);
    expect(store.mergeAuthorized(owner, source, target)).toMatchObject({ ok: true });
    expect(store.mergedIntoVisible(Access.agent(otherRepo.key), source)).toBe(target);
    expect(store.mergedIntoVisible(Access.agent(dataRepo.key), source)).toBeNull();
    expect(store.detailAuthorized(Access.agent(dataRepo.key), source)).toEqual({
      memory: null,
      mergedInto: null,
      archived: false,
      versions: [],
      duplicates: [],
    });
    expect(store.detailAuthorized(Access.agent(otherRepo.key), source).mergedInto).toBe(target);
  });
});
