import { afterEach, expect, it } from "bun:test";
import { Tokenizer } from "@huggingface/tokenizers";
import { retrieveContext } from "../service/context";
import {
  ContextBudget,
  type ContextBudgetInput,
  type ContextEntry,
  clipUnicode,
} from "../service/context-budget";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { MemoryStore } from "../service/store";
import { DEFAULT_RETRIEVAL_POLICY, type RetrievalBudget } from "../shared/retrieval";
import { DEFAULT_RUNTIME, type RuntimeConfig } from "../shared/service-api";
import { dataRepo, hashEmbedder, otherRepo, owner } from "./helpers";

const encoder = new Tokenizer(
  {
    version: "1.0",
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: "WhitespaceSplit" },
    post_processor: null,
    decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, alpha: 1, beta: 2 }, unk_token: "[UNK]" },
  },
  { unk_token: "[UNK]" },
);
const exact = {
  id: "fixture/wordlevel-0.2.0",
  count: (text: string) => encoder.encode(text, { add_special_tokens: false }).ids.length,
};
const limits: RetrievalBudget = {
  maxTokens: 10000,
  maxChars: 4000,
  maxBytes: 12000,
  maxItems: 10,
  maxCandidates: 60,
  maxLatencyMs: 750,
};
function entry(id: number, text: string, pinned = false): ContextEntry {
  return {
    key: `memory:${id}`,
    memoryRef: { id, revision: 1 },
    sessionId: null,
    evidenceRefs: [],
    text,
    section: "Task facts",
    priority: pinned ? 0 : 2,
    score: 100 - id,
    diversityKey: `topic:${id}`,
    pinned,
    task: !pinned,
    truncated: false,
  };
}
function frame(entries: readonly ContextEntry[], omitted: number): string {
  return [
    "<paseo-memory>",
    "# Selected evidence",
    ...entries.map((item) => item.text),
    ...(omitted ? [`Omitted pins: ${omitted}`] : []),
    "</paseo-memory>",
  ].join("\n");
}
type PackOptions = Omit<Partial<ContextBudgetInput>, "limits"> & { limits?: Partial<RetrievalBudget> };
function pack(entries: ContextEntry[], options: PackOptions = {}) {
  return new ContextBudget({
    reservedTokens: 0,
    reservedChars: 0,
    reservedBytes: 0,
    policyRevision: 1,
    indexGeneration: 1,
    render: frame,
    ...options,
    limits: { ...limits, ...options.limits },
  }).pack(entries);
}

it("counts exact tokens for the complete wrapper and known preceding assembly", () => {
  const prefix = "existing owner constraints";
  const result = pack(
    [entry(1, "alpha beta alpha beta"), entry(2, "alpha beta alpha beta"), entry(3, "alpha beta alpha beta")],
    { tokenizer: exact, prefix, limits: { maxTokens: 15 } },
  );
  const assembled = `${prefix}\n\n${result.contextText}`;
  expect(result.memoryRefs).toEqual([{ id: 1, revision: 1 }]);
  expect(encoder.encode(assembled, { add_special_tokens: false }).ids.length).toBeLessThanOrEqual(15);
  expect(result.usage.assembledTokenCount).toBe(
    encoder.encode(assembled, { add_special_tokens: false }).ids.length,
  );
  expect(result.usage.tokenCountIsEstimate).toBe(false);
});

it("bounds CJK, Unicode code, escaped citations and UTF-8 bytes independently", () => {
  const huge = `中文🚀 ${"const café = '值';\n".repeat(100)} evidence:${"x".repeat(3000)}`;
  const result = pack([entry(1, huge), entry(2, "中文🚀函数()")], {
    limits: { maxTokens: 300, maxChars: 180, maxBytes: 300 },
  });
  expect(result.memoryRefs).toEqual([{ id: 2, revision: 1 }]);
  expect(result.contextText.length).toBeLessThanOrEqual(180);
  expect(new TextEncoder().encode(result.contextText).byteLength).toBeLessThanOrEqual(300);
  expect(result.usage.estimator).toBe("utf8-byte-upper-bound");
  expect(result.usage.tokenCountIsEstimate).toBe(true);
  expect(result.truncated).toBe(true);
});

it("keeps pins bounded and reports pins beyond the candidate and item limits", () => {
  const pins = Array.from({ length: 30 }, (_, index) =>
    entry(index + 1, `Protected constraint ${index}`, true),
  );
  const result = pack([...pins, { ...entry(31, "High task score"), score: 10000 }], {
    totalPins: 50,
    limits: { maxItems: 2 },
  });
  expect(result.memoryRefs).toEqual([
    { id: 1, revision: 1 },
    { id: 2, revision: 1 },
  ]);
  expect(result.omittedPins).toBe(48);
  expect(result.omittedCount).toBe(49);
  expect(result.usage.chars).toBe(result.contextText.length);
});

it("packs diverse task facts rather than duplicate-topic results", () => {
  const result = pack(
    [
      { ...entry(1, "Primary fact"), score: 100, diversityKey: "same" },
      { ...entry(2, "Repeated topic"), score: 90, diversityKey: "same" },
      { ...entry(3, "Independent supporting fact"), score: 80 },
    ],
    { limits: { maxItems: 2 } },
  );
  expect(result.memoryRefs).toEqual([
    { id: 1, revision: 1 },
    { id: 3, revision: 1 },
  ]);
});

it("re-packs conservatively when an available tokenizer fails during final accounting", () => {
  let calls = 0;
  const unstable = {
    id: "fixture/failing-wordlevel",
    count(text: string) {
      if (++calls === 3) throw new Error("Tokenizer backend failed");
      return exact.count(text);
    },
  };
  const result = pack([entry(1, "alpha ".repeat(60)), entry(2, "Short fallback fact")], {
    tokenizer: unstable,
    limits: { maxTokens: 200 },
  });
  expect(result.memoryRefs).toEqual([{ id: 2, revision: 1 }]);
  expect(result.fallbackReason).toBe("tokenizer_failed");
  expect(result.usage.tokenCountIsEstimate).toBe(true);
  expect(new TextEncoder().encode(result.contextText).byteLength).toBeLessThanOrEqual(200);
});

it("does not force filler for empty evidence or trim preexisting owner instructions", () => {
  expect(pack([]).contextText).toBe("");
  const prefix = "Existing owner rule. ".repeat(50);
  const result = pack([entry(1, "A fact")], { prefix, limits: { maxChars: 200 } });
  expect(result.contextText).toBe("");
  expect(result.usage.assembledChars).toBe(prefix.length);
  expect(result.fallbackReason).toBe("preexisting_prompt_exceeds_allowance");
});

it("does not split surrogate pairs at a compact-detail boundary", () => {
  const clipped = clipUnicode("abc🚀def", 7);
  expect(clipped.text).toBe("abc...");
  expect(clipped.text.isWellFormed()).toBe(true);
  expect(clipped.truncated).toBe(true);
});

let store: MemoryStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});
function fixture(patch: Partial<RuntimeConfig> = {}) {
  const current = new MemoryStore({ path: ":memory:" });
  store = current;
  current.configure({
    ...DEFAULT_RUNTIME,
    ...patch,
    retrievalPolicy: {
      ...structuredClone(DEFAULT_RETRIEVAL_POLICY),
      reservedTokens: 0,
      reservedChars: 0,
      reservedBytes: 0,
      ...patch.retrievalPolicy,
    },
  });
  return current;
}
function seed(current: MemoryStore, title: string, content: string, pinned = false) {
  return current.mutations.mutate(ownerMutation(owner), {
    requestId: mutationRequestId(),
    operation: "create",
    change: { title, content, pinned, scope: "global" },
  });
}

it("includes owner instructions, separators and an existing prefix in the enforced assembly", async () => {
  const current = fixture({
    contextBudgetChars: 1600,
    detailLevel: "summaries",
    extraInstructions: "Owner retrieval instruction. ".repeat(10),
  });
  const protectedFact = seed(current, "Protected constraint", "Stable constraint ".repeat(30), true);
  for (let i = 0; i < 6; i++) seed(current, `Task fact ${i}`, "Supporting detail ".repeat(20));
  const prefix = "Existing owner constraints. ".repeat(15);
  const result = await retrieveContext({ store: current, project: null, assemblyPrefix: prefix });
  expect(result.memoryRefs).toContainEqual(protectedFact.memoryRef);
  const assembled = `${prefix}\n\n${result.contextText}`;
  expect(assembled.length).toBeLessThanOrEqual(1600);
  expect(result.usage.assembledChars).toBe(assembled.length);
  expect(result.omittedCount).toBeGreaterThan(0);
});

it("uses lexical fallback without starting inference for a zero-latency allowance", async () => {
  const current = fixture();
  const saved = seed(current, "Retention policy", "The retention period is seven days");
  const inner = hashEmbedder("test/context-deadline");
  let queries = 0;
  current.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") queries++;
      return inner.embed(texts, kind);
    },
  });
  await current.indexPending();
  const result = await retrieveContext({
    store: current,
    project: null,
    mode: "search",
    request: { query: "retention period", detail: "compact", budget: { maxLatencyMs: 0 } },
  });
  expect(result.memoryRefs).toContainEqual(saved.memoryRef);
  expect(result.contextText).toContain("seven days");
  expect(result.fallbackReason).toBe("deadline_lexical_fallback");
  expect(queries).toBe(0);
});

it("does not invoke inference when no serialized content allowance remains", async () => {
  const current = fixture();
  seed(current, "Budgeted fact", "Relevant detail");
  const inner = hashEmbedder("test/no-allowance");
  let queries = 0;
  current.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") queries++;
      return inner.embed(texts, kind);
    },
  });
  await current.indexPending();
  const result = await retrieveContext({
    store: current,
    project: null,
    request: { query: "relevant detail", budget: { maxTokens: 0 } },
  });
  expect(result.contextText).toBe("");
  expect(result.fallbackReason).toBe("insufficient_allowance");
  expect(queries).toBe(0);
});

it("cancels without late disclosure or usage tracking after deferred inference completes", async () => {
  const current = fixture();
  const saved = seed(current, "Cancelable policy", "The cancellation pipeline uses scoped facts");
  const inner = hashEmbedder("test/context-cancel");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  current.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        started.resolve();
        await gate.promise;
      }
      const result = await inner.embed(texts, kind);
      if (kind === "query") done.resolve();
      return result;
    },
  });
  await current.indexPending();
  const controller = new AbortController();
  const pending = retrieveContext({
    store: current,
    project: null,
    mode: "search",
    signal: controller.signal,
    request: { query: "cancellation pipeline" },
    complete: (result) => current.markShown(result.memoryRefs.map((ref) => ref.id)),
  });
  await started.promise;
  controller.abort();
  const result = await pending;
  expect(result.contextText).toBe("");
  expect(result.fallbackReason).toBe("canceled");
  gate.resolve();
  await done.promise;
  expect(current.getVisible(owner, [saved.memoryRef.id])[0]?.shown_count).toBe(0);
});

it("rechecks pins after a source moves while task inference is pending", async () => {
  const current = fixture();
  const secret = seed(current, "Private pinned constraint", "Private text must not survive a move", true);
  const inner = hashEmbedder("test/context-move");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  current.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  await current.indexPending();
  const pending = retrieveContext({
    store: current,
    project: dataRepo,
    request: { query: "constraint details" },
  });
  await started.promise;
  current.mutations.mutate(ownerMutation(owner), {
    requestId: "move-in-flight-pin",
    operation: "update",
    id: secret.memoryRef.id,
    expectedRevision: secret.memoryRef.revision,
    change: { scope: "project", project: otherRepo },
  });
  gate.resolve();
  const result = await pending;
  expect(result.memoryRefs).not.toContainEqual(secret.memoryRef);
  expect(result.contextText).not.toContain("Private text");
  expect(result.contextText).not.toContain("Private pinned constraint");
  expect(result.omittedPins).toBe(0);
});
