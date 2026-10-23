import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Access } from "../service/access";
import { openDatabase } from "../service/sqlite";
import { MemoryStore, type SaveInput } from "../service/store";
import { runUpkeep, upkeepPairs } from "../service/upkeep";
import { DEFAULT_RUNTIME } from "../shared/service-api";
import { dataRepo, hashSpec, mergeRequest, otherRepo, owner, tempDir } from "./helpers";

let store: MemoryStore;
let path: string;
beforeEach(() => {
  path = join(tempDir("pm-merge-safety-"), "memory.db");
  store = new MemoryStore({ path });
  store.configure({ ...DEFAULT_RUNTIME, duplicateMerge: "auto" });
  store.setEmbedder({
    spec: hashSpec("test/equal", 4),
    embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
  });
});
afterEach(() => store.close());
const base: SaveInput = {
  title: "Policy",
  content: "Use signed commits",
  type: "preference",
  scope: "project",
  project: dataRepo,
  force: true,
  source: "agent",
};
const save = async (patch: Partial<SaveInput> = {}) => Number((await store.save({ ...base, ...patch })).id);
const run = () => runUpkeep(store, "2026-10-23T00:00:00Z");

describe("conservative automatic consolidation", () => {
  it.each([
    ["negation", { content: "Do not use signed commits" }],
    ["different fact", { content: "Use isolated worktrees" }],
    ["meaningful punctuation", { content: "Use signed-commits" }],
    ["different title", { title: "Exception to policy" }],
  ] satisfies [string, Partial<SaveInput>][])(
    "keeps %s distinct even at identical vector similarity",
    async (_label, patch) => {
      const a = await save();
      const b = await save(patch);
      expect(run().merged).toBe(0);
      expect(
        store
          .getVisible(owner, [a, b])
          .map((row) => row.id)
          .sort(),
      ).toEqual([a, b]);
    },
  );

  it("preserves a project exception to a global preference sharing its topic", async () => {
    const a = await save({ scope: "global", project: null, topicKey: "signing" });
    const b = await save({
      content: "Do not require signed commits for generated vendor updates",
      topicKey: "signing",
    });
    expect(run().merged).toBe(0);
    expect(store.getVisible(owner, [a, b])).toHaveLength(2);
    expect(upkeepPairs(store, dataRepo).conflicts).toEqual([
      expect.objectContaining({ reason: "negation", sameTopic: true }),
    ]);
  });

  it("never automatically merges identical content across namespaces", async () => {
    const a = await save({ scope: "global", project: null, topicKey: "signing" });
    const b = await save({ topicKey: "signing" });
    const c = await save({ project: otherRepo, topicKey: "signing" });
    expect(run().merged).toBe(0);
    expect(store.getVisible(owner, [a, b, c])).toHaveLength(3);
  });

  it.each([
    ["source authority", { source: "user" }],
    ["agent authority", { agentId: "another-agent" }],
    ["pin validity", { pinned: true }],
  ] satisfies [string, Partial<SaveInput>][])(
    "requires matching %s for canonical duplicates",
    async (_label, patch) => {
      const a = await save({ title: "Caf\u00e9" });
      const b = await save({ title: "Cafe\u0301", ...patch });
      expect(run().merged).toBe(0);
      expect(store.getVisible(owner, [a, b])).toHaveLength(2);
    },
  );

  it("automatically merges only matching canonical text, namespace, authority and validity", async () => {
    const a = await save({ title: "Caf\u00e9" });
    const b = await save({ title: "Cafe\u0301" });
    store.markUsed([b]);
    expect(run().merged).toBe(1);
    expect(store.detailAuthorized(owner, a)).toMatchObject({
      memory: null,
      mergedInto: b,
      mergeId: expect.any(Number),
    });
    expect(store.getVisible(owner, [b])[0]?.content).toBe(base.content);
  });
});

describe("revision guarded merge and undo", () => {
  it("rejects stale source or target revisions without deleting either record", async () => {
    const a = await save();
    const b = await save({ title: "Second policy", content: "Keep history" });
    const request = mergeRequest(store, a, b);
    store.updateAuthorized(owner, b, { content: "Updated target" });
    expect(store.mergeAuthorized(owner, request)).toMatchObject({ ok: false, conflict: true });
    const fresh = mergeRequest(store, a, b);
    store.updateAuthorized(owner, a, { pinned: true });
    expect(store.mergeAuthorized(owner, fresh)).toMatchObject({ ok: false, conflict: true });
    expect(store.getVisible(owner, [a, b])).toHaveLength(2);
  });

  it("records both snapshots and relation, then undo preserves identity, history and indexes", async () => {
    const a = await save();
    const b = await save({ title: "Second policy", content: "Keep history" });
    store.updateAuthorized(owner, a, { content: "Require signed commits" });
    await store.indexPending();
    const before = store.getVisible(owner, [a])[0];
    const merged = store.mergeAuthorized(owner, mergeRequest(store, a, b));
    expect({ ...merged }).toMatchObject({ ok: true, mergeId: expect.any(Number) });
    const mergeId = merged.mergeId as number;
    const { db } = openDatabase(path);
    try {
      const row = db
        .query<{ source_snapshot: string; target_snapshot: string; relation: string }, [number]>(
          "SELECT * FROM memory_merges WHERE id = ?",
        )
        .get(mergeId);
      expect(row?.relation).toBe("duplicate_of");
      expect(JSON.parse(row?.source_snapshot ?? "null")).toMatchObject({
        id: a,
        content: "Require signed commits",
        record_revision: 2,
      });
      expect(JSON.parse(row?.target_snapshot ?? "null")).toMatchObject({ id: b, content: "Keep history" });
    } finally {
      db.close();
    }
    expect(store.undoMergeAuthorized(Access.agent(dataRepo.key), mergeId).ok).toBe(false);
    expect(store.getVisible(owner, [a])).toEqual([]);
    expect(store.undoMergeAuthorized(owner, mergeId).ok).toBe(true);
    const restored = store.detailAuthorized(owner, a);
    expect(restored.memory).toMatchObject({ id: a, content: "Require signed commits", recordRevision: 4 });
    expect(restored.versions.map((version) => version.content)).toEqual([
      "Require signed commits",
      "Use signed commits",
    ]);
    expect(store.getVisible(owner, [a])[0]?.index_generation).toBe((before?.index_generation ?? 0) + 1);
    await store.indexPending();
    expect(
      (await store.search({ access: Access.agent(dataRepo.key), query: "signed" })).map((hit) => hit.id),
    ).toContain(String(a));
    expect(store.undoMergeAuthorized(owner, mergeId).ok).toBe(false);
    expect(store.getVisible(owner, [a, b])).toHaveLength(2);
  });

  it("refuses undo if a new live memory claimed the source topic", async () => {
    const a = await save({ topicKey: "signing" });
    const b = await save({ title: "Other", content: "Other policy" });
    const merged = store.mergeAuthorized(owner, mergeRequest(store, a, b));
    const replacement = await save({ title: "Replacement", content: "New topic fact", topicKey: "signing" });
    expect(store.undoMergeAuthorized(owner, merged.mergeId as number).ok).toBe(false);
    expect(store.getVisible(owner, [a])).toEqual([]);
    expect(store.getVisible(owner, [replacement])[0]?.content).toBe("New topic fact");
  });
});

describe("v6 review extension upgrade", () => {
  it("adds review and merge persistence without resetting existing memory revisions or vector generations", async () => {
    const id = await save();
    store.updateAuthorized(owner, id, { content: "A corrected durable fact" });
    await store.indexPending();
    const before = store.getVisible(owner, [id])[0];
    store.close();
    const { db } = openDatabase(path);
    db.run("DROP TABLE review_ops; DROP TABLE review_windows; DROP TABLE memory_merges;");
    db.close();
    store = new MemoryStore({ path });
    expect(store.getVisible(owner, [id])[0]).toMatchObject({
      id,
      content: "A corrected durable fact",
      record_revision: before?.record_revision,
      index_generation: before?.index_generation,
    });
    store.reviews.open({ agentId: "agent", nonce: "nonce", trigger: "idle", cap: 1 });
    const reservation = store.reviews.admit("nonce", "update", "update");
    if (reservation.kind !== "granted") throw new Error("missing reservation");
    expect(store.updateAuthorized(owner, id, { pinned: true }, reservation.reservation)).toBe("ok");
    expect(store.reviews.info("nonce")?.committed).toBe(1);
  });
});
