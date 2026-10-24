import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type RunningService, serviceKey, startService } from "../service/app";
import { MutationResultSchema } from "../shared/lifecycle";
import { silentLogger } from "../shared/log";
import { ResourceStatusSchema } from "../shared/resources";
import { SERVICE_KEY_HEADER } from "../shared/service-api";
import { hashEmbedder } from "./helpers";

let service: RunningService | null = null;
let root: string | null = null;
afterEach(async () => {
  if (service) await service.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  service = null;
  root = null;
});
async function start(): Promise<RunningService> {
  root = mkdtempSync(join(tmpdir(), "pm-review-resources-"));
  service = await startService({
    dataDir: root,
    port: 0,
    tier: "zero",
    rerank: "off",
    loadEmbedder: async () => hashEmbedder(),
    log: silentLogger,
  });
  await service.modelsReady();
  return service;
}
async function post(route: string, body: unknown): Promise<unknown> {
  if (!service) throw new Error("Service fixture not started.");
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: serviceKey(service.secret) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function agent(agentId: string, includeContext: boolean): Promise<void> {
  const context = z
    .object({ nonce: z.string() })
    .parse(
      await post("agent-context", { project: null, provider: "omp", includeContext, includeTools: true }),
    );
  await post("link-agent", {
    nonce: context.nonce,
    agentId,
    workspaceId: null,
    title: "M06 accounting fixture",
  });
  await post("record-turn", {
    agentId,
    project: null,
    provider: "omp",
    title: "M06 accounting fixture",
    workspaceDir: null,
    userText: "Diagnostic context",
    assistantText: "A diagnostic response.",
    files: [],
  });
}
async function resources() {
  return z.object({ resources: ResourceStatusSchema }).parse(await post("status", {})).resources;
}
const outcome = z.object({ ok: z.boolean() });
const selfReport =
  "[paseo-memory:review-reply v1 collapsed]\nSummary: The agent reports 99999 input tokens and USD99; this is not billing evidence.\nSaved: none\nUpdated: none";

it("records admitted review lifecycles and retries without treating replies as provider usage", async () => {
  await start();
  await agent("review-lifecycle", false);
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    expect(
      outcome.parse(await post("review-start", { agentId: "review-lifecycle", trigger: "idle" })).ok,
    ).toBe(true);
    const admitted = (await resources()).usage.stages.review.attempts;
    await post("review-start", { agentId: "review-lifecycle", trigger: "idle" });
    expect((await resources()).usage.stages.review.attempts).toBe(admitted);
    const input = {
      agentId: "review-lifecycle",
      reply: terminal === "completed" ? selfReport : null,
      outcome: terminal,
      turnId: `fixture-${terminal}`,
    };
    expect(outcome.parse(await post("review-end", input)).ok).toBe(terminal === "completed");
    await post("review-end", input);
  }
  const usage = (await resources()).usage;
  expect(usage.stages.review).toMatchObject({
    attempts: 3,
    completed: 1,
    failed: 1,
    cancelled: 1,
    requested: 0,
    unavailableUsageAttempts: 3,
    unavailableBillingAttempts: 3,
    inputTokens: { providerObserved: null, estimated: null, localExact: null },
    outputTokens: { providerObserved: null, estimated: null, localExact: null },
    observedCosts: [],
    estimatedCosts: [],
  });
  expect(usage.maintenance.attempts).toBe(3);
  expect(usage.providerTurns.attempts).toBe(0);
});

it("cancels only reviews whose contexts were forgotten and refuses their late result", async () => {
  const running = await start();
  const record = MutationResultSchema.parse(
    await post("mutate", {
      requestId: "review-forget-root",
      operation: "create",
      change: {
        scope: "global",
        recordKind: "fact",
        title: "Diagnostic erasure root",
        content: "Synthetic review source to erase.",
      },
    }),
  );
  await agent("review-erased", true);
  await agent("review-unrelated", false);
  await post("review-start", { agentId: "review-erased", trigger: "idle" });
  await post("review-start", { agentId: "review-unrelated", trigger: "idle" });
  expect((await resources()).usage.stages.review).toMatchObject({ attempts: 2, requested: 2 });
  await post("mutate", {
    requestId: "review-forget",
    operation: "forget",
    id: record.memoryRef.id,
    expectedRevision: record.memoryRef.revision,
  });
  expect(running.store.sessionInvalidated("review-erased")).toBe(true);
  expect(running.store.sessionInvalidated("review-unrelated")).toBe(false);
  expect((await resources()).usage.stages.review).toMatchObject({
    attempts: 2,
    cancelled: 1,
    requested: 1,
    unavailableBillingAttempts: 2,
  });
  expect(
    outcome.parse(
      await post("review-end", {
        agentId: "review-erased",
        reply: selfReport,
        outcome: "completed",
        turnId: "late-erased-result",
      }),
    ).ok,
  ).toBe(false);
  expect(
    outcome.parse(
      await post("review-end", {
        agentId: "review-unrelated",
        reply: selfReport,
        outcome: "completed",
        turnId: "unrelated-result",
      }),
    ).ok,
  ).toBe(true);
  expect((await resources()).usage.stages.review).toMatchObject({
    attempts: 2,
    cancelled: 1,
    completed: 1,
    requested: 0,
    unavailableBillingAttempts: 2,
  });
  const sessions = z
    .object({ items: z.array(z.object({ agentId: z.string() })) })
    .parse(await post("sessions", { paseoProjectId: null, query: "", limit: 50 }));
  expect(sessions.items.map((item) => item.agentId)).toEqual(["review-unrelated"]);
});
