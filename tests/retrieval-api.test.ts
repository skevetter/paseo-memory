import { afterEach, beforeEach, expect, it } from "bun:test";
import { Tokenizer } from "@huggingface/tokenizers";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { silentLogger } from "../shared/log";
import { DEFAULT_RETRIEVAL_POLICY, RetrievalResultSchema } from "../shared/retrieval";
import { DEFAULT_RUNTIME, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, owner, tempDir } from "./helpers";

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
const tokenizer = {
  id: "fixture/wordlevel-0.2.0",
  count: (text: string) => encoder.encode(text, { add_special_tokens: false }).ids.length,
};
let service: RunningService;
beforeEach(async () => {
  service = await startService({
    dataDir: tempDir("pm-retrieval-api-"),
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
    contextTokenizers: new Map([["fixture-provider", tokenizer]]),
  });
  await service.modelsReady();
  service.store.upsertProject(dataRepo);
  service.store.configure({
    ...DEFAULT_RUNTIME,
    detailLevel: "summaries",
    retrievalPolicy: {
      ...structuredClone(DEFAULT_RETRIEVAL_POLICY),
      reservedTokens: 0,
      reservedChars: 0,
      reservedBytes: 0,
    },
  });
});
afterEach(async () => {
  await service.stop();
});
async function internal(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
const toolSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z
      .object({
        retrieval: RetrievalResultSchema.omit({ contextText: true }).optional(),
        error: z.object({ code: z.string() }).optional(),
      })
      .passthrough()
      .optional(),
  }),
});
async function tool(name: string, args: unknown, nonce = "reader") {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(service.secret, {
        projectKey: dataRepo.key,
        agentId: `agent-${nonce}`,
        provider: "fixture-provider",
        nonce,
      }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mutationRequestId(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  return toolSchema.parse(await response.json()).result;
}
function seed(title: string, content: string, pinned = false) {
  return service.store.mutations.mutate(ownerMutation(owner), {
    requestId: mutationRequestId(),
    operation: "create",
    change: { title, content, pinned, scope: "global" },
  });
}
function bundle(result: z.infer<typeof toolSchema>["result"]) {
  expect(result.isError).not.toBe(true);
  return RetrievalResultSchema.parse({
    ...result.structuredContent?.retrieval,
    contextText: result.content.map((part) => part.text).join("\n"),
  });
}

it("enforces full known agent assembly with the trusted tokenizer and owner reservations", async () => {
  const policy = structuredClone(DEFAULT_RETRIEVAL_POLICY);
  Object.assign(policy, { reservedTokens: 20, reservedChars: 100, reservedBytes: 300 });
  Object.assign(policy.profiles.standard, { maxTokens: 160, maxChars: 1600, maxBytes: 4800 });
  service.store.configure({
    ...DEFAULT_RUNTIME,
    contextBudgetChars: 1600,
    detailLevel: "summaries",
    extraInstructions: "Owner retrieval instruction. ".repeat(5),
    retrievalPolicy: policy,
  });
  const stable = seed("Protected constraint", "The stable deployment constraint stays bounded", true);
  for (let i = 0; i < 5; i++) seed(`Supporting fact ${i}`, "Supporting deployment detail ".repeat(15));
  const prefix = "Existing owner constraints ".repeat(5);
  const response = await internal("agent-context", {
    project: dataRepo,
    provider: "fixture-provider",
    includeContext: true,
    includeTools: true,
    assemblyPrefix: prefix,
    retrieval: { tokenizerId: tokenizer.id },
    taskBudgetMs: 1000,
  });
  expect(response.status).toBe(200);
  const result = RetrievalResultSchema.parse(
    z.object({ context: RetrievalResultSchema }).parse(response.body).context,
  );
  expect(result.memoryRefs).toContainEqual(stable.memoryRef);
  const assembled = `${prefix}\n\n${result.contextText}`;
  expect(assembled.length).toBeLessThanOrEqual(1500);
  expect(Buffer.byteLength(assembled, "utf8")).toBeLessThanOrEqual(4500);
  expect(tokenizer.count(assembled)).toBeLessThanOrEqual(140);
  expect(result.usage.assembledTokenCount).toBe(tokenizer.count(assembled));
  expect(result.usage.tokenCountIsEstimate).toBe(false);
  expect(result.usage.assembledChars).toBe(assembled.length);
  expect(result.usage.reservedTokens).toBe(20);
});

it("rejects ungranted profiles and prevents a model from expanding owner caps", async () => {
  const policy = structuredClone(DEFAULT_RETRIEVAL_POLICY);
  policy.reservedTokens = 0;
  policy.reservedChars = 0;
  policy.reservedBytes = 0;
  policy.profiles.standard.maxItems = 1;
  policy.profiles.standard.maxChars = 1500;
  service.store.configure({ ...DEFAULT_RUNTIME, detailLevel: "summaries", retrievalPolicy: policy });
  for (let i = 0; i < 3; i++) seed(`Bounded record ${i}`, `Bounded visible detail ${i}`);
  const denied = await tool("memory_context", { profile: "evidence" });
  expect(denied.structuredContent?.error?.code).toBe("scope_denied");
  const result = bundle(
    await tool("memory_context", {
      budget: { maxItems: 100000, maxChars: 100000, maxTokens: 100000, maxBytes: 100000 },
      detail: "full",
    }),
  );
  expect(result.memoryRefs).toHaveLength(1);
  expect(result.usage.chars).toBeLessThanOrEqual(1500);
  expect(result.omittedCount).toBe(2);
  const forged = await tool("memory_context", { grants: { global: true }, budget: { reservedTokens: 0 } });
  expect(forged.isError).toBe(true);
});

it("labels unavailable tokenizers conservatively and does not duplicate rendered content in metadata", async () => {
  const source = seed("Unicode source", "中文 🚀 code: const alpha = `引用`; bounded source text");
  const raw = await tool("memory_get", {
    ids: [source.memoryRef.id],
    retrieval: { detail: "compact", tokenizerId: "unavailable/provider-tokenizer" },
  });
  const result = bundle(raw);
  expect(result.contextText).toContain("中文 🚀");
  expect(result.usage.chars).toBe(result.contextText.length);
  expect(result.usage.bytes).toBe(Buffer.byteLength(result.contextText, "utf8"));
  expect(result.usage.tokenCount).toBe(result.usage.bytes);
  expect(result.usage.tokenCountIsEstimate).toBe(true);
  expect(result.usage.estimator).toBe("utf8-byte-upper-bound");
  expect(result.fallbackReason).toBe("tokenizer_unavailable");
  expect(raw.structuredContent?.retrieval).not.toHaveProperty("contextText");
});

it("returns no filler for empty evidence and uses lexical fallback without inference at zero allowance", async () => {
  const empty = bundle(await tool("memory_context", {}));
  expect(empty.contextText).toBe("");
  expect(empty.usage.chars).toBe(0);
  expect(empty.memoryRefs).toEqual([]);
  const source = seed("Retention rule", "Retain the rollout trace for seven days");
  const inner = hashEmbedder("test/api-zero-latency");
  let queries = 0;
  service.store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") queries++;
      return inner.embed(texts, kind);
    },
  });
  await service.store.indexPending();
  const result = bundle(
    await tool("memory_search", {
      query: "rollout trace",
      retrieval: { detail: "compact", budget: { maxLatencyMs: 0 } },
    }),
  );
  expect(result.memoryRefs).toContainEqual(source.memoryRef);
  expect(result.contextText).toContain("seven days");
  expect(result.fallbackReason).toBe("deadline_lexical_fallback");
  expect(queries).toBe(0);
});

it("revokes an already-running retrieval before disclosure when its signed context is forgotten", async () => {
  const source = seed("Protected source", "A unique forgotten disclosure phrase");
  await tool("memory_get", { ids: [source.memoryRef.id] }, "inflight");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const inner = hashEmbedder("test/api-inflight-forget");
  service.store.setEmbedder({
    spec: inner.spec,
    async embed(texts, kind) {
      if (kind === "query") {
        started.resolve();
        await gate.promise;
      }
      return inner.embed(texts, kind);
    },
  });
  await service.store.indexPending();
  const policy = structuredClone(service.store.config.retrievalPolicy);
  policy.profiles.standard.maxLatencyMs = 5000;
  service.store.configure({ ...service.store.config, retrievalPolicy: policy });
  const pending = tool(
    "memory_search",
    {
      query: "forgotten disclosure phrase",
      retrieval: { detail: "compact", budget: { maxLatencyMs: 5000 } },
    },
    "inflight",
  );
  await started.promise;
  const forgotten = await internal("mutate", {
    requestId: "forget-during-inference",
    operation: "forget",
    id: source.memoryRef.id,
    expectedRevision: source.memoryRef.revision,
  });
  expect(forgotten.status).toBe(200);
  gate.resolve();
  const result = await pending;
  expect(result.structuredContent?.error?.code).toBe("context_invalidated");
  expect(result.content.map((part) => part.text).join("\n")).not.toContain(
    "A unique forgotten disclosure phrase",
  );
  expect(service.store.audit.eventsSince("inflight", "2000-01-01T00:00:00.000Z")).toEqual([]);
});
