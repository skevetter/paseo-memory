import { afterAll, afterEach, beforeAll, expect, it, setSystemTime } from "bun:test";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { signCaller } from "../service/mcp";
import { ForgetPreviewSchema, LifecycleDetailSchema, MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { HistoricalMemorySchema, SERVICE_KEY_HEADER } from "../shared/service-api";
import { dataRepo, hashEmbedder, tempDir } from "./helpers";

let service: RunningService;
beforeAll(async () => {
  service = await startService({
    dataDir: tempDir("pm-lifecycle-api-"),
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
  service.store.upsertProject(dataRepo);
});
afterAll(() => service.stop());
afterEach(() => setSystemTime());

async function internal(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const toolResponse = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z.object({ error: z.object({ code: z.string(), message: z.string() }) }).optional(),
  }),
});

async function tool(name: string, args: unknown, nonce: string | null, id: string) {
  const response = await fetch(service.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...signCaller(service.secret, {
        projectKey: dataRepo.key,
        agentId: nonce === null ? null : `agent-${nonce}`,
        provider: null,
        nonce,
      }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const result = toolResponse.parse(await response.json()).result;
  return { ...result, text: result.content.map((item) => item.text).join("\n") };
}

async function create(requestId: string, title: string, content: string) {
  const response = await internal("mutate", {
    requestId,
    operation: "create",
    change: { title, content, scope: "global" },
  });
  expect(response.status).toBe(200);
  return MutationResultSchema.parse(response.body);
}

it("accepts one concurrent correction, reports CAS details, and replays only the same body", async () => {
  setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
  const saved = await internal("save", {
    requestId: "owner-save",
    title: "CAS deployment region",
    content: "Deploy to east",
    type: "config",
    scope: "global",
    paseoProjectId: null,
    project: null,
    pinned: false,
  });
  expect(saved.status).toBe(200);
  const initial = MutationResultSchema.parse(saved.body);
  expect(initial.state).toBe("active");
  expect(initial.evidenceValidation).toBe("none");
  const before = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: initial.memoryRef.id })).body,
  );
  expect(before.verificationStatus).toBe("unverified");
  const firstTime = before.revisions.find(
    (revision) => revision.revision === initial.memoryRef.revision,
  )?.changedAt;
  if (!firstTime) throw new Error("Initial revision was not recorded.");
  setSystemTime(new Date("2026-10-01T00:00:01.000Z"));
  const changes = ["west", "central"].map((region) => ({
    requestId: `owner-${region}`,
    operation: "update",
    id: initial.memoryRef.id,
    expectedRevision: initial.memoryRef.revision,
    change: { content: `Deploy to ${region}` },
  }));
  const responses = await Promise.all(changes.map((body) => internal("mutate", body)));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const winnerIndex = responses.findIndex((response) => response.status === 200);
  const winningResponse = responses[winnerIndex];
  if (!winningResponse) throw new Error("No correction was accepted.");
  const winner = MutationResultSchema.parse(winningResponse.body);
  expect(winner.memoryRef.revision).toBe(initial.memoryRef.revision + 1);
  const conflict = responses.find((response) => response.status === 409);
  if (!conflict) throw new Error("The concurrent correction did not conflict.");
  expect(conflict.body).toMatchObject({
    error: {
      code: "revision_conflict",
      retryable: false,
      details: {
        currentRevision: winner.memoryRef.revision,
        diff: expect.arrayContaining([
          expect.objectContaining({ field: "content", previous: "Deploy to east" }),
        ]),
      },
    },
  });
  const replay = await internal("mutate", changes[winnerIndex]);
  expect(replay.body).toEqual(winner);
  expect(
    (await internal("mutate", { ...changes[winnerIndex], change: { content: "Overwrite" } })).body,
  ).toMatchObject({ error: { code: "request_conflict" } });
  expect(
    (
      await internal("mutate", {
        requestId: "no-cas",
        operation: "update",
        id: initial.memoryRef.id,
        change: { content: "No CAS" },
      })
    ).body,
  ).toMatchObject({ error: { code: "revision_conflict" } });
  expect((await internal("update", { id: initial.memoryRef.id, content: "Missing revision" })).status).toBe(
    400,
  );
  const historical = await internal("historical", { id: initial.memoryRef.id, asOf: firstTime });
  expect(historical.status).toBe(200);
  expect(HistoricalMemorySchema.parse(historical.body)).toMatchObject({
    memoryRef: initial.memoryRef,
    content: "Deploy to east",
    verificationStatus: "unverified",
  });
});

it("discloses canonical evidence and invalidates/forgets an allowlisted source without replay resurrection", async () => {
  const artifact = await internal("evidence-artifact", {
    sourceRef: "artifact:api-deploy-log",
    content: "Deployment completed at version 7.",
    scope: "global",
    projectKey: null,
    allowExcerpt: true,
    sourceEventAt: "2026-01-01T00:00:00.000Z",
  });
  expect(artifact.status).toBe(200);
  const source = z.object({ sourceRef: z.string(), sourceHash: z.string() }).parse(artifact.body);
  const request = {
    requestId: "artifact-fact",
    operation: "create",
    evidence: [{ sourceKind: "artifact", ...source, includeExcerpt: true }],
    change: { title: "Artifact verified deployment", content: "Version 7 was deployed", scope: "global" },
  };
  const created = await internal("mutate", request);
  expect(created.status).toBe(200);
  const memory = MutationResultSchema.parse(created.body);
  expect(memory.evidenceValidation).toBe("resolved");
  const detail = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: memory.memoryRef.id })).body,
  );
  expect(detail.evidence).toEqual([
    expect.objectContaining({
      sourceRef: source.sourceRef,
      sourceHash: source.sourceHash,
      status: "resolved",
      sourceEventAt: "2026-01-01T00:00:00.000Z",
      excerpt: "Deployment completed at version 7.",
    }),
  ]);
  expect(detail.evidence[0]?.observedAt).toEqual(expect.any(String));
  expect(detail.evidence[0]?.storedAt).not.toBe("2026-01-01T00:00:00.000Z");
  const preview = ForgetPreviewSchema.parse(
    (await internal("forget-preview", { id: memory.memoryRef.id })).body,
  );
  expect(preview.records).toContainEqual(memory.memoryRef);
  expect(preview.sources).toContain(source.sourceRef);
  expect((await internal("source-invalidate", { sourceRef: source.sourceRef })).body).toMatchObject({
    affected: 1,
  });
  const invalidated = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: memory.memoryRef.id })).body,
  );
  expect(invalidated.state).toBe("needs_recheck");
  expect(invalidated.evidence[0]?.status).toBe("unresolved");
  expect(
    (await internal("source-forget", { sourceRef: source.sourceRef, requestId: "forget-artifact" })).body,
  ).toMatchObject({ forgotten: 1 });
  expect((await internal("lifecycle-detail", { id: memory.memoryRef.id })).body).toBeNull();
  expect(
    (await internal("historical", { id: memory.memoryRef.id, asOf: new Date().toISOString() })).body,
  ).toBeNull();
  expect((await internal("mutate", request)).body).toMatchObject({ error: { code: "context_invalidated" } });
});

it("excludes a summary after its source revision changes", async () => {
  const source = await create("dependency-source", "Dependency source", "Primary color is green");
  const summaryResponse = await internal("mutate", {
    requestId: "dependency-summary",
    operation: "create",
    evidence: [
      { sourceKind: "memory", sourceRef: `memory:${source.memoryRef.id}@${source.memoryRef.revision}` },
    ],
    change: {
      title: "Dependent color digest",
      content: "A green primary color is configured",
      scope: "global",
      recordKind: "derived_summary",
    },
  });
  expect(summaryResponse.status).toBe(200);
  const summary = MutationResultSchema.parse(summaryResponse.body);
  expect(
    (
      await internal("mutate", {
        requestId: "dependency-correction",
        operation: "update",
        id: source.memoryRef.id,
        expectedRevision: source.memoryRef.revision,
        change: { content: "Primary color is blue" },
      })
    ).status,
  ).toBe(200);
  const detail = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: summary.memoryRef.id })).body,
  );
  expect(detail.state).toBe("needs_recheck");
  const search = await internal("search", {
    query: "Dependent color digest",
    paseoProjectId: null,
    scope: "all",
    limit: 50,
  });
  expect(search.body).not.toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ id: String(summary.memoryRef.id) })]),
  });
});

it("keeps agent assertions out of retrieval and denies self-promotion and preference authority", async () => {
  const mutation = {
    requestId: "agent-candidate",
    operation: "create",
    change: {
      title: "Unsupported quartz theorem",
      content: "Quartz always predicts task success",
      scope: "project",
      project: dataRepo,
    },
  };
  const response = await tool("memory_mutate", mutation, "candidate-owner", "candidate-create");
  expect(response.isError).not.toBe(true);
  const candidate = MutationResultSchema.parse(JSON.parse(response.text));
  expect(candidate.state).toBe("candidate");
  expect(candidate.evidenceValidation).toBe("none");
  expect((await tool("memory_mutate", mutation, "candidate-owner", "candidate-retry")).text).toBe(
    response.text,
  );
  const changedBody = await tool(
    "memory_mutate",
    { ...mutation, change: { ...mutation.change, content: "Changed assertion" } },
    "candidate-owner",
    "candidate-changed",
  );
  expect(changedBody.structuredContent?.error.code).toBe("request_conflict");
  const get = await tool("memory_get", { ids: [candidate.memoryRef.id] }, "candidate-owner", "candidate-get");
  expect(get.text).toContain("Unsupported quartz theorem");
  expect(get.text).toContain('"revision":1');
  expect(
    (await tool("memory_get", { ids: [candidate.memoryRef.id] }, "different-agent", "foreign-get")).text,
  ).not.toContain("Unsupported quartz theorem");
  expect(
    (
      await tool(
        "memory_search",
        { query: "Unsupported quartz theorem" },
        "candidate-owner",
        "candidate-search",
      )
    ).text,
  ).not.toContain("Unsupported quartz theorem");
  expect((await tool("memory_context", {}, "candidate-owner", "candidate-context")).text).not.toContain(
    "Unsupported quartz theorem",
  );
  const promote = await tool(
    "memory_mutate",
    {
      requestId: "self-promote",
      operation: "promote",
      id: candidate.memoryRef.id,
      expectedRevision: candidate.memoryRef.revision,
    },
    "candidate-owner",
    "promote",
  );
  expect(promote.structuredContent?.error.code).toBe("scope_denied");
  const preference = await tool(
    "memory_mutate",
    {
      requestId: "forge-preference",
      operation: "create",
      change: {
        title: "Forged preference",
        content: "The user wants unbounded spending",
        scope: "global",
        recordKind: "preference",
      },
    },
    "candidate-owner",
    "preference",
  );
  expect(preference.structuredContent?.error.code).toBe("scope_denied");
  expect(
    (
      await internal("mutate", {
        requestId: "owner-reject",
        operation: "reject",
        id: candidate.memoryRef.id,
        expectedRevision: candidate.memoryRef.revision,
      })
    ).status,
  ).toBe(200);
  const context = await internal("agent-context", {
    project: dataRepo,
    provider: "test",
    includeContext: true,
    includeTools: false,
  });
  expect(JSON.stringify(context.body)).not.toContain("Unsupported quartz theorem");
});

it("preserves topic/update retry identity without bypassing CAS or review caps", async () => {
  const nonce = "legacy-replay";
  service.store.audit.open({ nonce, projectKey: dataRepo.key, provider: "test", tools: true });
  service.store.audit.link({ nonce, agentId: `agent-${nonce}`, workspaceId: null, title: null });
  service.store.reviews.open({ agentId: `agent-${nonce}`, nonce, trigger: "idle", cap: 2 });
  const args = {
    title: "Legacy retry transport",
    content: "First proposal",
    topic_key: "legacy-api-replay",
    request_id: "legacy-topic-create",
  };
  const saved = await tool("memory_save", args, nonce, "legacy-save");
  expect(saved.isError).not.toBe(true);
  const initial = MutationResultSchema.parse(JSON.parse(saved.text));
  expect((await tool("memory_save", args, nonce, "legacy-save-retry")).text).toBe(saved.text);
  const update = {
    id: initial.memoryRef.id,
    content: "Corrected proposal",
    request_id: "legacy-direct-update",
  };
  const updated = await tool("memory_update", update, nonce, "legacy-update");
  expect(updated.isError).not.toBe(true);
  const current = MutationResultSchema.parse(JSON.parse(updated.text));
  expect(current.memoryRef.revision).toBe(initial.memoryRef.revision + 1);
  // Both successful slots are exhausted; authorized replay must still return the original receipt.
  expect((await tool("memory_update", update, nonce, "legacy-update-retry")).text).toBe(updated.text);
  expect(
    (
      await tool(
        "memory_update",
        { ...update, content: "Changed replay body" },
        nonce,
        "legacy-update-changed",
      )
    ).structuredContent?.error.code,
  ).toBe("request_conflict");
  expect(
    (
      await tool(
        "memory_mutate",
        {
          requestId: "stale-direct",
          operation: "update",
          id: initial.memoryRef.id,
          expectedRevision: initial.memoryRef.revision,
          change: { content: "Stale update" },
        },
        nonce,
        "stale",
      )
    ).isError,
  ).toBe(true);
});

it("gates merge undo on both current revisions and retains the source history", async () => {
  const source = await create("merge-source", "Merge source policy", "Keep daily snapshots");
  const target = await create(
    "merge-target",
    "Merge target policy",
    "Keep daily snapshots and weekly archives",
  );
  const merged = await internal("merge", {
    requestId: "merge-ui",
    sourceId: source.memoryRef.id,
    targetId: target.memoryRef.id,
    sourceRevision: source.memoryRef.revision,
    targetRevision: target.memoryRef.revision,
  });
  expect(merged.status).toBe(200);
  const mergeId = z.object({ mergeId: z.number() }).parse(merged.body).mergeId;
  const detailSchema = z.object({
    mergeRevisions: z.object({ sourceRevision: z.number(), targetRevision: z.number() }),
  });
  const before = detailSchema.parse(
    (await internal("detail", { id: source.memoryRef.id })).body,
  ).mergeRevisions;
  const currentTarget = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: target.memoryRef.id })).body,
  );
  expect(
    (
      await internal("update", {
        requestId: "edit-target-after-merge",
        id: target.memoryRef.id,
        expectedRevision: currentTarget.memoryRef.revision,
        content: "Keep daily snapshots and monthly archives",
      })
    ).status,
  ).toBe(200);
  const staleUndo = await internal("merge-undo", { mergeId, ...before });
  expect(staleUndo.status).toBe(409);
  expect(staleUndo.body).toMatchObject({ error: { code: "revision_conflict" } });
  const after = detailSchema.parse(
    (await internal("detail", { id: source.memoryRef.id })).body,
  ).mergeRevisions;
  expect((await internal("merge-undo", { mergeId, ...after })).body).toMatchObject({ ok: true });
  const restored = LifecycleDetailSchema.parse(
    (await internal("lifecycle-detail", { id: source.memoryRef.id })).body,
  );
  expect(restored.state).toBe("active");
  expect(restored.memoryRef.revision).toBeGreaterThan(source.memoryRef.revision);
  expect(restored.revisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        revision: source.memoryRef.revision,
        snapshot: expect.objectContaining({ content: "Keep daily snapshots" }),
      }),
    ]),
  );
});

it("identifies sessions that learned forgotten content only through get or search tools", async () => {
  const saved = await create(
    "tool-disclosure",
    "Tool-only disclosure",
    "Important fact seen only through explicit tools",
  );
  for (const nonce of ["read-only", "search-only", "unexposed"]) {
    service.store.audit.open({ nonce, projectKey: dataRepo.key, provider: null, tools: true });
    service.store.audit.link({ nonce, agentId: `agent-${nonce}`, workspaceId: null, title: null });
  }
  const read = await tool("memory_get", { ids: [saved.memoryRef.id] }, "read-only", "read");
  expect(read.text).toContain("Important fact seen only through explicit tools");
  const search = await tool(
    "memory_search",
    { query: "Tool-only disclosure", scope: "global" },
    "search-only",
    "search",
  );
  expect(search.text).toContain("Tool-only disclosure");
  const preview = ForgetPreviewSchema.parse(
    (await internal("forget-preview", { id: saved.memoryRef.id })).body,
  );
  expect(preview.affectedAgentIds.sort()).toEqual(["agent-read-only", "agent-search-only"]);
  expect(preview.limits.join(" ")).toContain("cannot be retracted");
  const capture = {
    agentId: "agent-read-only",
    project: dataRepo,
    provider: null,
    title: "Affected session",
    workspaceDir: null,
    userText: "Use the remembered fact",
    assistantText: "Important fact seen only through explicit tools",
    files: [],
  };
  expect((await internal("record-turn", capture)).body).toMatchObject({ recorded: true });
  expect(
    (
      await internal("mutate", {
        requestId: "erase-disclosed-copy",
        operation: "forget",
        id: saved.memoryRef.id,
        expectedRevision: saved.memoryRef.revision,
      })
    ).status,
  ).toBe(200);
  expect((await internal("record-turn", capture)).body).toMatchObject({ recorded: false });
  expect(
    (await internal("review-start", { agentId: "agent-read-only", trigger: "idle" })).body,
  ).toMatchObject({ ok: false });
  expect(
    service.store
      .sessions({ projectKey: dataRepo.key, query: "", limit: 50 })
      .find((session) => session.agent_id === "agent-read-only"),
  ).toBeUndefined();
  for (const [name, args] of [
    ["memory_get", { ids: [saved.memoryRef.id] }],
    ["memory_context", {}],
    ["memory_save", { title: "Recreated forgotten fact", content: capture.assistantText, scope: "global" }],
    [
      "memory_mutate",
      {
        requestId: "recreate-after-forget",
        operation: "create",
        change: { title: "Recreated assertion", content: capture.assistantText, scope: "global" },
      },
    ],
  ] as const) {
    const blocked = await tool(name, args, "read-only", `stale-${name}`);
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent?.error.code).toBe("context_invalidated");
  }
  const fresh = await tool(
    "memory_save",
    { title: "Fresh context", content: "A genuinely new assertion", scope: "global" },
    "fresh-authorized",
    "fresh-save",
  );
  expect(MutationResultSchema.parse(JSON.parse(fresh.text)).state).toBe("candidate");
});

it("revokes unbound and stateless signed readers after erasure", async () => {
  for (const nonce of ["unbound-reader", null]) {
    const suffix = nonce ?? "stateless";
    const saved = await create(`source-${suffix}`, `Private ${suffix} fact`, `Forgotten ${suffix} content`);
    const read = await tool("memory_get", { ids: [saved.memoryRef.id] }, nonce, `get-${suffix}`);
    expect(read.text).toContain(`Forgotten ${suffix} content`);
    expect(
      (
        await internal("mutate", {
          requestId: `forget-${suffix}`,
          operation: "forget",
          id: saved.memoryRef.id,
          expectedRevision: saved.memoryRef.revision,
        })
      ).status,
    ).toBe(200);
    const blocked = await tool(
      "memory_save",
      { title: `Recreated ${suffix}`, content: `Forgotten ${suffix} content`, scope: "global" },
      nonce,
      `recreate-${suffix}`,
    );
    expect(blocked.structuredContent?.error.code).toBe("context_invalidated");
  }
});

it("restores candidate and rejected dispositions on merge undo without promotion", async () => {
  for (const state of ["candidate", "rejected"] as const) {
    const proposed = await tool(
      "memory_save",
      { title: `Undo ${state} claim`, content: `Unvalidated ${state} assertion`, scope: "global" },
      `undo-${state}`,
      `propose-${state}`,
    );
    let source = MutationResultSchema.parse(JSON.parse(proposed.text));
    if (state === "rejected") {
      source = MutationResultSchema.parse(
        (
          await internal("mutate", {
            requestId: "reject-undo-source",
            operation: "reject",
            id: source.memoryRef.id,
            expectedRevision: source.memoryRef.revision,
          })
        ).body,
      );
    }
    const target = await create(
      `target-${state}`,
      `Accepted target ${state}`,
      "Owner-maintained destination",
    );
    const merged = await internal("merge", {
      requestId: `merge-${state}`,
      sourceId: source.memoryRef.id,
      targetId: target.memoryRef.id,
      sourceRevision: source.memoryRef.revision,
      targetRevision: target.memoryRef.revision,
    });
    expect(merged.status).toBe(200);
    const mergeId = z.object({ mergeId: z.number() }).parse(merged.body).mergeId;
    const detail = z
      .object({ mergeRevisions: z.object({ sourceRevision: z.number(), targetRevision: z.number() }) })
      .parse((await internal("detail", { id: source.memoryRef.id })).body);
    expect((await internal("merge-undo", { mergeId, ...detail.mergeRevisions })).body).toMatchObject({
      ok: true,
    });
    expect(
      LifecycleDetailSchema.parse((await internal("lifecycle-detail", { id: source.memoryRef.id })).body)
        .state,
    ).toBe(state);
    const fetched = await tool(
      "memory_get",
      { ids: [source.memoryRef.id] },
      `fresh-after-${state}`,
      `get-undone-${state}`,
    );
    expect(fetched.text).not.toContain(`Unvalidated ${state} assertion`);
  }
});
