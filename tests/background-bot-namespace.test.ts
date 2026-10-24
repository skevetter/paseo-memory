import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Access, type NamespaceGrants } from "../service/access";
import type { MemoryFeedback } from "../service/feedback";
import {
  type MemoryMutations,
  MutationError,
  type MutationPrincipal,
  mutationRequestId,
} from "../service/mutations";
import { MemoryStore } from "../service/store";
import { runUpkeep } from "../service/upkeep";
import type { MemoryNamespace } from "../shared/namespaces";
import { DEFAULT_RUNTIME } from "../shared/service-api";
import { hashSpec, owner, removeTempDirs, tempDir } from "./helpers";

type FeedbackRaw = Parameters<MemoryFeedback["record"]>[1];
type MutateRaw = Parameters<MemoryMutations["mutate"]>[1];

const alphaBot: MemoryNamespace = { kind: "bot", botId: "alpha" };
const betaBot: MemoryNamespace = { kind: "bot", botId: "beta" };

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore({ path: join(tempDir("pm-bg-bot-ns-"), "memory.db") });
  store.configure({ ...DEFAULT_RUNTIME, duplicateMerge: "auto" });
  store.setEmbedder({
    spec: hashSpec("test/equal", 4),
    embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
  });
});
afterEach(() => {
  store.close();
  removeTempDirs();
});

function caller(id: string, grants: NamespaceGrants): MutationPrincipal {
  return { id, actorId: id, access: Access.scoped(grants) };
}

const alpha = caller("caller-alpha", { read: [alphaBot], write: [alphaBot] });
const beta = caller("caller-beta", { read: [betaBot], write: [betaBot] });

function createBotMemory(principal: MutationPrincipal, botId: string) {
  const request: MutateRaw = {
    requestId: mutationRequestId(),
    operation: "create",
    change: { title: "Bot note", content: "Bot note bounded claim", scope: "bot", botId },
  };
  return store.mutations.mutate(principal, request);
}

function botNote(botId: string, title = "Bot note") {
  return store.save({
    title,
    content: "Bot note bounded claim",
    type: "preference",
    scope: "bot",
    project: null,
    botId,
    force: true,
    source: "agent",
  });
}

function feedback(memoryRef: FeedbackRaw["memoryRef"], eventId: string): FeedbackRaw {
  return {
    eventId,
    retrievalId: "ret-1",
    memoryRef,
    signal: "helpful",
    basis: "agent_report",
    evidenceRefs: [],
  };
}

function failure(run: () => unknown): MutationError {
  try {
    run();
  } catch (error) {
    if (error instanceof MutationError) return error;
    throw error;
  }
  throw new Error("expected a MutationError");
}

const run = () => runUpkeep(store, "2026-10-23T00:00:00Z");

describe("bot namespace feedback references", () => {
  it("hides a bot memory from a foreign bot's feedback reference", () => {
    const made = createBotMemory(alpha, "alpha");

    const denied = failure(() => store.feedback.record(beta, feedback(made.memoryRef, "evt-beta")));

    expect(denied.code).toBe("scope_denied");
  });
});

describe("bot namespace forget preview", () => {
  it("lets the owner preview a bot memory and refuses a scoped bot caller", () => {
    const made = createBotMemory(alpha, "alpha");

    const preview = store.lifecycle.preview(owner, made.memoryRef.id);

    expect(preview.records.map((record) => record.id)).toContain(made.memoryRef.id);
    expect(() => store.lifecycle.preview(alpha.access, made.memoryRef.id)).toThrow(Error);
  });
});

describe("bot namespace upkeep dedupe", () => {
  it("never merges identical memories from two bots that share a null project key", async () => {
    const first = Number((await botNote("alpha")).id);
    const second = Number((await botNote("beta")).id);
    await store.indexPending();

    expect(run()).toMatchObject({ duplicates: 0, merged: 0 });
    expect(store.getVisible(owner, [first, second])).toHaveLength(2);
  });

  it("still reports and merges an exact duplicate inside one bot namespace", async () => {
    const first = Number((await botNote("alpha", "Café bot note")).id);
    const second = Number((await botNote("alpha", "Cafe\u0301 bot note")).id);
    expect(first).not.toBe(second);
    await store.indexPending();

    expect(run()).toMatchObject({ duplicates: 1, merged: 1 });
    expect(store.getVisible(owner, [first, second]).map((row) => row.id)).toHaveLength(1);
  });
});
