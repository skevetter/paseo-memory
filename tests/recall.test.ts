import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { retrieveContext } from "../service/context";
import type { Embedder } from "../service/embedder";
import { MemoryStore, type SaveInput } from "../service/store";
import { isTaskMatch } from "../service/task";
import { runUpkeep, UPKEEP_NONCE, upkeepPairs } from "../service/upkeep";
import { DEFAULT_RUNTIME, type RuntimeConfig } from "../shared/service-api";
import { dataRepo, hashEmbedder, hashSpec, owner } from "./helpers";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore({ path: ":memory:" });
});
afterEach(() => store.close());

const configure = (patch: Partial<RuntimeConfig>) => store.configure({ ...DEFAULT_RUNTIME, ...patch });
const project = { type: "note", scope: "project" as const, project: dataRepo, force: true };
const global = { type: "note", scope: "global" as const, project: null, force: true };
const saveId = async (input: SaveInput) => (await store.save(input)).id as number;
const sameVector = (model: string): Embedder => ({
  spec: hashSpec(model, 4),
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
});

describe("starting memory selection", () => {
  it("respects owner section counts and reports unselected pins", async () => {
    const pins: number[] = [];
    for (let i = 0; i < 4; i++)
      pins.push(await saveId({ ...global, title: `Pinned ${i}`, content: "p", pinned: true }));
    for (let i = 0; i < 6; i++) await store.save({ ...project, title: `Project note ${i}`, content: "c" });
    for (let i = 0; i < 5; i++) await store.save({ ...global, title: `Global note ${i}`, content: "g" });
    for (let i = 0; i < 4; i++)
      store.recordTurn({
        agentId: `agent-${i}`,
        project: dataRepo,
        provider: "omp",
        title: null,
        workspaceDir: null,
        userText: `task ${i}`,
        assistantText: `done ${i}`,
        files: [],
      });
    configure({ maxPinned: 2, projectMemories: 3, globalMemories: 1, recentSessions: 2 });
    const result = await retrieveContext({ store, project: dataRepo });
    const selected = store.getVisible(
      owner,
      result.memoryRefs.map((ref) => ref.id),
    );
    expect(selected.filter((row) => row.pinned).map((row) => row.id)).toEqual(pins.slice(0, 2));
    expect(selected.filter((row) => row.title.startsWith("Project note")).map((row) => row.scope)).toEqual([
      "project",
      "project",
      "project",
    ]);
    expect(selected.filter((row) => row.title.startsWith("Global note")).map((row) => row.scope)).toEqual([
      "global",
    ]);
    expect(result.sessionIds).toHaveLength(2);
    expect(result.omittedPins).toBe(2);
    configure({ maxPinned: 0, projectMemories: 0, globalMemories: 0, recentSessions: 0 });
    expect((await retrieveContext({ store, project: dataRepo })).contextText).toBe("");
  });

  it("keeps fact bodies reference-only until the owner or caller requests allowed detail", async () => {
    await store.save({ ...project, title: "Kafka retention", content: "Seven days on every topic." });
    expect((await retrieveContext({ store, project: dataRepo })).contextText).not.toContain(
      "Seven days on every topic.",
    );
    expect(
      (await retrieveContext({ store, project: dataRepo, request: { detail: "compact" } })).contextText,
    ).toContain("Seven days on every topic.");
    configure({ detailLevel: "summaries" });
    expect((await retrieveContext({ store, project: dataRepo })).contextText).toContain(
      "Seven days on every topic.",
    );
  });
});

describe("task matches", () => {
  const seed = async () => {
    store.setEmbedder(hashEmbedder());
    const match = await saveId({
      ...project,
      title: "Gateway limits",
      content: "Payment retries stop after three attempts because the gateway rate limits us",
    });
    const other = await saveId({
      ...project,
      title: "Mobile stack",
      content: "Frontend uses React Native for the app",
    });
    await store.indexPending();
    return { match, other };
  };
  const task = { query: "why do payment retries stop after three attempts", source: "prompt" as const };

  it("selects task facts once while retaining permitted general context", async () => {
    const { match, other } = await seed();
    const result = await retrieveContext({ store, project: dataRepo, task });
    expect(result.taskIds).toEqual([match]);
    expect(result.memoryRefs.filter((ref) => ref.id === match)).toEqual([{ id: match, revision: 1 }]);
    expect(result.memoryRefs).toContainEqual({ id: other, revision: 1 });
  });

  it("does not classify unrelated or owner-disabled retrieval as task matches", async () => {
    await seed();
    const unrelated = { query: "kubernetes ingress annotations", source: "names" as const };
    expect((await retrieveContext({ store, project: dataRepo, task: unrelated })).taskIds).toEqual([]);
    configure({ taskMatches: 0 });
    expect((await retrieveContext({ store, project: dataRepo, task })).taskIds).toEqual([]);
  });

  it("needs both the re-ranker and the vector score to clear their floors, and keyword hits only without a model", () => {
    const hit = { relevance: 0.5, similarity: 0.6 };
    const floor = { rerank: 0.4, vector: 0.56, keywordOnly: false };
    expect(isTaskMatch(hit, floor)).toBe(true);
    expect(isTaskMatch({ ...hit, relevance: 0.3 }, floor)).toBe(false);
    expect(isTaskMatch({ ...hit, similarity: 0.5 }, floor)).toBe(false);
    expect(isTaskMatch({ ...hit, relevance: null }, floor)).toBe(true);
    const keyword = { ...hit, relevance: null, similarity: null };
    expect(isTaskMatch(keyword, floor)).toBe(false);
    expect(isTaskMatch(keyword, { ...floor, vector: null, keywordOnly: true })).toBe(true);
    expect(isTaskMatch(keyword, { ...floor, vector: null })).toBe(false);
    expect(isTaskMatch({ ...keyword, relevance: 0.5 }, { ...floor, vector: null })).toBe(true);
  });
});

describe("usage feedback", () => {
  const twoEqual = async () => {
    const base = { ...global, content: "grafana dashboards live in the ops folder" };
    return [await saveId({ ...base, title: "Grafana A" }), await saveId({ ...base, title: "Grafana B" })];
  };

  it("demotes memories shown ten times and never opened, and boosts ones that agents open", async () => {
    const [a, b] = (await twoEqual()) as [number, number];
    for (let i = 0; i < 10; i++) store.markShown([a, b]);
    store.markOpened([b]);
    const order = async () =>
      (await store.search({ query: "grafana dashboards", access: owner })).map((h) => h.id);
    expect(await order()).toEqual([String(b), String(a)]);
    for (let i = 0; i < 3; i++) store.markOpened([a]);
    expect(await order()).toEqual([String(a), String(b)]);
  });

  it("applies to the starting list and turns off with the setting", async () => {
    await twoEqual();
    const order = async () =>
      (await store.search({ query: "grafana dashboards", access: owner })).map((h) => h.id);
    const [first, second] = (await order()).map(Number) as [number, number];
    for (let i = 0; i < 10; i++) store.markShown([first, second]);
    store.markOpened([second]);
    expect(await order()).toEqual([String(second), String(first)]);
    expect((await retrieveContext({ store, project: null })).memoryRefs.map((ref) => ref.id)).toEqual([
      second,
      first,
    ]);
    configure({ usageRanking: false });
    expect(await order()).toEqual([String(first), String(second)]);
  });
});

describe("upkeep", () => {
  it("suggests approximate duplicates without automatically discarding different facts", async () => {
    store.setEmbedder(sameVector("test/upkeep"));
    const older = await saveId({ ...project, type: "decision", title: "Picked Postgres", content: "joins" });
    const used = await saveId({ ...project, type: "decision", title: "Chose Postgres", content: "JSONB" });
    store.markShown([used]);
    const { duplicates, conflicts } = upkeepPairs(store, dataRepo);
    expect(conflicts).toEqual([]);
    expect(duplicates).toEqual([
      expect.objectContaining({ targetId: used, similarity: 1, sameTopic: false, exact: false }),
    ]);
    configure({ duplicateMerge: "auto" });
    expect(runUpkeep(store, "2026-10-07T00:00:00Z")).toMatchObject({ duplicates: 1, merged: 0 });
    expect(store.getVisible(owner, [older, used])).toHaveLength(2);
    expect(store.audit.eventsSince(UPKEEP_NONCE, "2026-01-01")).toEqual([]);
  });

  it("flags differing values as possible conflicts and never merges them", async () => {
    store.setEmbedder(sameVector("test/conflict"));
    const a = await saveId({
      ...project,
      type: "config",
      title: "Memory port",
      content: "The service port is 6797",
    });
    const b = await saveId({
      ...project,
      type: "config",
      title: "Memory port",
      content: "The service port is 6798",
    });
    configure({ duplicateMerge: "auto" });
    const { conflicts, duplicates } = upkeepPairs(store, dataRepo);
    expect(duplicates).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ values: { a: ["6797"], b: ["6798"] }, similarity: 1 }),
    ]);
    expect(runUpkeep(store, "2026-10-07T00:00:00Z")).toMatchObject({ conflicts: 1, merged: 0 });
    expect(store.getVisible(owner, [a, b])).toHaveLength(2);
    store.dismissPair(b, a);
    expect(upkeepPairs(store, dataRepo).conflicts).toEqual([]);
  });

  it("pairs a project and a global memory with the same topic key, and is quiet when off", async () => {
    await store.save({ ...project, title: "Retry cap", content: "3 attempts", topicKey: "billing/retries" });
    await store.save({ ...global, title: "Retry cap", content: "5 attempts", topicKey: "billing/retries" });
    expect(upkeepPairs(store, dataRepo).conflicts).toEqual([expect.objectContaining({ sameTopic: true })]);
    configure({ duplicateMerge: "off" });
    expect(upkeepPairs(store, dataRepo)).toEqual({ duplicates: [], conflicts: [] });
  });

  it("lists unpinned memories untouched for the stale window; keep resets it and archive removes it", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const timed = new MemoryStore({ path: ":memory:", now: () => now });
    try {
      timed.configure({ ...DEFAULT_RUNTIME, staleDays: 30 });
      const old = (await timed.save({ ...global, title: "Old", content: "o" })).id as number;
      const kept = (await timed.save({ ...global, title: "Kept", content: "k" })).id as number;
      await timed.save({ ...global, title: "Pinned", content: "p", pinned: true });
      now = new Date("2026-02-15T00:00:00Z");
      const stale = () => timed.list({ access: owner, stale: true }).map((h) => Number(h.id));
      expect(stale()).toEqual([old, kept]);
      expect(timed.keep(owner, kept)).toBe("ok");
      expect(stale()).toEqual([old]);
      expect(timed.archive(owner, old)).toBe("ok");
      expect(stale()).toEqual([]);
      expect(timed.detailAuthorized(owner, old)).toMatchObject({
        memory: null,
        archived: true,
        mergedInto: null,
      });
    } finally {
      timed.close();
    }
  });
});
