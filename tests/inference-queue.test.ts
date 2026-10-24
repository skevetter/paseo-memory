import { describe, expect, it } from "bun:test";
import { InferenceQueue, InferenceQueueError } from "../service/inference-queue";
import { INFERENCE_STAGES } from "../shared/inference";

describe("inference admission", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 9])(
    "refuses invalid concurrency %s",
    (concurrency) => {
      expect(() => new InferenceQueue({ concurrency })).toThrow(RangeError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 257])(
    "refuses invalid pending capacity %s",
    (maxPending) => {
      expect(() => new InferenceQueue({ maxPending })).toThrow(RangeError);
    },
  );

  it("bounds a default startup burst and rejects excess work without invoking it", async () => {
    let now = 0;
    const queue = new InferenceQueue({ now: () => now });
    const backend = Promise.withResolvers<void>();
    const started: number[] = [];
    const accepted = Array.from({ length: 34 }, (_, index) =>
      queue.run("query_embedding", () => {
        started.push(index);
        return backend.promise.then(() => index);
      }),
    );
    let overflowInvoked = false;
    const overflow = queue.run("rerank", async () => {
      overflowInvoked = true;
      return "overflow";
    });
    await expect(overflow).rejects.toMatchObject({ code: "inference_overloaded" });
    expect(started).toEqual([0, 1]);
    expect(queue.snapshot()).toMatchObject({
      active: 2,
      pending: 32,
      oldestQueuedMs: 1,
      counts: { completed: 0, failed: 0, cancelled: 0, rejected: 1 },
      latencyMs: { p50: null, p95: null, samples: 0 },
      stages: { rerank: { counts: { rejected: 1 }, latencyMs: { samples: 0 } } },
    });
    now = 10;
    backend.resolve();
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 34 }, (_, index) => index));
    expect(started).toEqual(Array.from({ length: 34 }, (_, index) => index));
    expect(overflowInvoked).toBe(false);
    expect(queue.snapshot()).toMatchObject({
      active: 0,
      pending: 0,
      oldestQueuedMs: 0,
      counts: { completed: 34, failed: 0, cancelled: 0, rejected: 1 },
    });
  });

  it("permits zero waiting slots while preserving capacity for later calls", async () => {
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 0, now: () => 0 });
    const backend = Promise.withResolvers<string>();
    const active = queue.run("document_embedding", () => backend.promise);
    await expect(queue.run("query_embedding", async () => "overflow")).rejects.toBeInstanceOf(
      InferenceQueueError,
    );
    expect(queue.snapshot()).toMatchObject({ active: 1, pending: 0 });
    backend.resolve("first");
    expect(await active).toBe("first");
    expect(await queue.run("rerank", async () => "after release")).toBe("after release");
    expect(queue.snapshot().counts).toEqual({ completed: 2, failed: 0, cancelled: 0, rejected: 1 });
  });
});

describe("inference dispatch", () => {
  it("dispatches waiting work FIFO across stages as either active slot becomes available", async () => {
    const queue = new InferenceQueue({ concurrency: 2, maxPending: 2, now: () => 0 });
    const jobs = [
      { stage: "document_embedding", gate: Promise.withResolvers<number>() },
      { stage: "query_embedding", gate: Promise.withResolvers<number>() },
      { stage: "rerank", gate: Promise.withResolvers<number>() },
      { stage: "query_embedding", gate: Promise.withResolvers<number>() },
    ] as const;
    const started: number[] = [];
    const callers = jobs.map((job, index) =>
      queue.run(job.stage, () => {
        started.push(index);
        return job.gate.promise;
      }),
    );
    expect(started).toEqual([0, 1]);
    jobs[1].gate.resolve(1);
    expect(await callers[1]).toBe(1);
    expect(started).toEqual([0, 1, 2]);
    jobs[0].gate.resolve(0);
    expect(await callers[0]).toBe(0);
    expect(started).toEqual([0, 1, 2, 3]);
    jobs[2].gate.resolve(2);
    jobs[3].gate.resolve(3);
    expect(await Promise.all(callers)).toEqual([0, 1, 2, 3]);
    expect(queue.snapshot()).toMatchObject({ active: 0, pending: 0, counts: { completed: 4 } });
  });

  it("releases a synchronously throwing backend and preserves its original failure", async () => {
    const queue = new InferenceQueue({ concurrency: 1, now: () => 5 });
    const failure = new Error("backend failure");
    const failed = queue.run("document_embedding", () => {
      throw failure;
    });
    const next = queue.run("query_embedding", async () => "next result");
    await expect(failed).rejects.toBe(failure);
    expect(await next).toBe("next result");
    expect(queue.snapshot()).toMatchObject({
      active: 0,
      pending: 0,
      counts: { completed: 1, failed: 1, cancelled: 0, rejected: 0 },
      latencyMs: { p50: 0, p95: 0, samples: 2 },
    });
  });
});

describe("inference cancellation", () => {
  it("does not execute pre-aborted work or misclassify it as overloaded", async () => {
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 0, now: () => 0 });
    const backend = Promise.withResolvers<string>();
    const running = queue.run("document_embedding", () => backend.promise);
    let invoked = false;
    const cancelled = queue.run(
      "query_embedding",
      async () => {
        invoked = true;
        return "not allowed";
      },
      { signal: AbortSignal.abort("caller stopped") },
    );
    await expect(cancelled).rejects.toMatchObject({ code: "inference_cancelled" });
    expect(invoked).toBe(false);
    expect(queue.snapshot()).toMatchObject({
      active: 1,
      pending: 0,
      counts: { cancelled: 1, rejected: 0 },
      stages: { query_embedding: { latencyMs: { p50: 0, p95: 0, samples: 1 } } },
    });
    backend.resolve("running result");
    expect(await running).toBe("running result");
  });

  it("removes a queued aborted caller immediately and admits its FIFO replacement", async () => {
    let now = 0;
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 1, now: () => now });
    const backend = Promise.withResolvers<string>();
    const first = queue.run("document_embedding", () => backend.promise);
    const controller = new AbortController();
    const started: string[] = [];
    now = 3;
    const cancelled = queue.run(
      "query_embedding",
      async () => {
        started.push("cancelled");
        return "not allowed";
      },
      { signal: controller.signal },
    );
    now = 8;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "inference_cancelled" });
    expect(queue.snapshot()).toMatchObject({
      active: 1,
      pending: 0,
      oldestQueuedMs: 0,
      counts: { cancelled: 1 },
      stages: { query_embedding: { latencyMs: { p50: 5, p95: 5, samples: 1 } } },
    });
    const replacement = queue.run("rerank", async () => {
      started.push("replacement");
      return "replacement result";
    });
    now = 10;
    backend.resolve("first result");
    expect(await first).toBe("first result");
    expect(await replacement).toBe("replacement result");
    expect(started).toEqual(["replacement"]);
  });
});

describe("running inference cancellation", () => {
  it.each(["resolve", "reject"] as const)(
    "keeps an uncooperative cancelled backend occupied until its late %s",
    async (settlement) => {
      let now = 0;
      const queue = new InferenceQueue({ concurrency: 1, maxPending: 1, now: () => now });
      const backend = Promise.withResolvers<string>();
      const controller = new AbortController();
      const backendSignals: AbortSignal[] = [];
      const cancelled = queue.run(
        "document_embedding",
        (signal) => {
          backendSignals.push(signal);
          return backend.promise;
        },
        { signal: controller.signal },
      );
      let nextStarted = false;
      const next = queue.run("query_embedding", async () => {
        nextStarted = true;
        return "queued result";
      });
      now = 20;
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "inference_cancelled" });
      expect(backendSignals[0]?.aborted).toBe(true);
      expect(nextStarted).toBe(false);
      expect(queue.snapshot()).toMatchObject({
        active: 1,
        pending: 1,
        counts: { completed: 0, failed: 0, cancelled: 1, rejected: 0 },
        latencyMs: { p50: 20, p95: 20, samples: 1 },
      });
      await expect(queue.run("rerank", async () => "overflow")).rejects.toMatchObject({
        code: "inference_overloaded",
      });
      now = 100;
      if (settlement === "resolve") backend.resolve("late result");
      else backend.reject(new Error("late backend failure"));
      expect(await next).toBe("queued result");
      expect(queue.snapshot()).toMatchObject({
        active: 0,
        pending: 0,
        counts: { completed: 1, failed: 0, cancelled: 1, rejected: 1 },
        stages: {
          document_embedding: {
            counts: { completed: 0, failed: 0, cancelled: 1, rejected: 0 },
            latencyMs: { p50: 20, p95: 20, samples: 1 },
          },
        },
      });
    },
  );
});

describe("inference pending cancellation", () => {
  it("bulk-cancels only waiting work and leaves running callers usable", async () => {
    let now = 0;
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 2, now: () => now });
    const backend = Promise.withResolvers<string>();
    const signals: AbortSignal[] = [];
    const running = queue.run("document_embedding", (signal) => {
      signals.push(signal);
      return backend.promise;
    });
    const started: string[] = [];
    const waiting = ["first", "second"].map((label) =>
      queue.run("query_embedding", async () => {
        started.push(label);
        return label;
      }),
    );
    now = 12;
    expect(queue.cancelPending("privacy policy changed")).toBe(2);
    for (const caller of waiting) {
      await expect(caller).rejects.toMatchObject({
        code: "inference_cancelled",
        message: "privacy policy changed",
      });
    }
    expect(queue.cancelPending()).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
    expect(queue.snapshot()).toMatchObject({
      active: 1,
      pending: 0,
      counts: { completed: 0, failed: 0, cancelled: 2, rejected: 0 },
      latencyMs: { p50: 12, p95: 12, samples: 2 },
    });
    const replacement = queue.run("rerank", async () => {
      started.push("replacement");
      return "replacement result";
    });
    backend.resolve("running result");
    expect(await running).toBe("running result");
    expect(await replacement).toBe("replacement result");
    expect(started).toEqual(["replacement"]);
  });
});

describe("inference shutdown", () => {
  it("close settles every caller without releasing real work or dispatching queued work", async () => {
    let now = 0;
    const queue = new InferenceQueue({ concurrency: 2, maxPending: 2, now: () => now });
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const signals: AbortSignal[] = [];
    const started: string[] = [];
    const running = [first, second].map((backend, index) =>
      queue.run("document_embedding", (signal) => {
        signals.push(signal);
        started.push(`running ${index}`);
        return backend.promise;
      }),
    );
    const waiting = ["queued first", "queued second"].map((label) =>
      queue.run("query_embedding", async () => {
        started.push(label);
        return label;
      }),
    );
    now = 10;
    queue.close();
    queue.close();
    for (const caller of [...running, ...waiting]) {
      await expect(caller).rejects.toMatchObject({ code: "inference_closed" });
    }
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(queue.snapshot()).toMatchObject({
      active: 2,
      pending: 0,
      oldestQueuedMs: 0,
      counts: { completed: 0, failed: 0, cancelled: 4, rejected: 0 },
      latencyMs: { p50: 10, p95: 10, samples: 4 },
    });
    await expect(queue.run("rerank", async () => "after close")).rejects.toMatchObject({
      code: "inference_closed",
    });
    now = 100;
    first.resolve("late first");
    await first.promise;
    expect(queue.snapshot().active).toBe(1);
    second.reject(new Error("late second failure"));
    await second.promise.catch(() => undefined);
    expect(started).toEqual(["running 0", "running 1"]);
    expect(queue.snapshot()).toMatchObject({
      active: 0,
      pending: 0,
      counts: { completed: 0, failed: 0, cancelled: 4, rejected: 1 },
      latencyMs: { p50: 10, p95: 10, samples: 4 },
    });
  });

  it("honors close called synchronously by a backend during dispatch", async () => {
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 2, now: () => 0 });
    const first = Promise.withResolvers<string>();
    const closing = Promise.withResolvers<string>();
    const started: string[] = [];
    const firstCaller = queue.run("document_embedding", () => first.promise);
    const closingCaller = queue.run("query_embedding", () => {
      started.push("closing");
      queue.close();
      return closing.promise;
    });
    const waiting = queue.run("rerank", async () => {
      started.push("not allowed");
      return "not allowed";
    });
    first.resolve("first result");
    expect(await firstCaller).toBe("first result");
    await expect(closingCaller).rejects.toMatchObject({ code: "inference_closed" });
    await expect(waiting).rejects.toMatchObject({ code: "inference_closed" });
    expect(queue.snapshot()).toMatchObject({ active: 1, pending: 0, counts: { cancelled: 2 } });
    closing.resolve("late result");
    await closing.promise;
    expect(started).toEqual(["closing"]);
    expect(queue.snapshot()).toMatchObject({ active: 0, counts: { completed: 1, cancelled: 2 } });
  });
});

describe("inference diagnostics", () => {
  it("includes queue wait, failed work and cancellation in fixed-stage latency", async () => {
    let now = 100;
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 2, now: () => now });
    expect(queue.snapshot().latencyMs).toEqual({ p50: null, p95: null, samples: 0 });
    const document = Promise.withResolvers<string>();
    const query = Promise.withResolvers<string>();
    const controller = new AbortController();
    const documentCaller = queue.run("document_embedding", () => document.promise);
    now = 103;
    const queryCaller = queue.run("query_embedding", () => query.promise);
    now = 105;
    const cancelled = queue.run("rerank", async () => "not allowed", { signal: controller.signal });
    now = 107;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "inference_cancelled" });
    expect(queue.snapshot().oldestQueuedMs).toBe(4);
    now = 110;
    document.resolve("document result");
    expect(await documentCaller).toBe("document result");
    now = 130;
    const failure = new Error("query failure");
    query.reject(failure);
    await expect(queryCaller).rejects.toBe(failure);
    expect(queue.snapshot()).toMatchObject({
      active: 0,
      pending: 0,
      oldestQueuedMs: 0,
      counts: { completed: 1, failed: 1, cancelled: 1, rejected: 0 },
      latencyMs: { p50: 10, p95: 27, samples: 3 },
      stages: {
        document_embedding: { latencyMs: { p50: 10, p95: 10, samples: 1 } },
        query_embedding: { latencyMs: { p50: 27, p95: 27, samples: 1 } },
        rerank: { latencyMs: { p50: 2, p95: 2, samples: 1 } },
      },
    });
  });

  it("retains only the latest 256 settled latencies globally and for each stage", async () => {
    let now = 0;
    const queue = new InferenceQueue({ now: () => now });
    for (const stage of INFERENCE_STAGES) {
      for (let elapsed = 1; elapsed <= 300; elapsed++) {
        const backend = Promise.withResolvers<number>();
        const caller = queue.run(stage, () => backend.promise);
        now += elapsed;
        backend.resolve(elapsed);
        expect(await caller).toBe(elapsed);
      }
    }
    const snapshot = queue.snapshot();
    expect(snapshot.counts).toEqual({ completed: 900, failed: 0, cancelled: 0, rejected: 0 });
    expect(snapshot.latencyMs).toEqual({ p50: 172, p95: 288, samples: 256 });
    for (const stage of INFERENCE_STAGES) {
      expect(snapshot.stages[stage]).toEqual({
        counts: { completed: 300, failed: 0, cancelled: 0, rejected: 0 },
        latencyMs: { p50: 172, p95: 288, samples: 256 },
      });
    }
  });

  it("does not let a diagnostic consumer alter capacity or outcome accounting", async () => {
    const queue = new InferenceQueue({ concurrency: 1, maxPending: 0, now: () => 0 });
    const backend = Promise.withResolvers<string>();
    const running = queue.run("query_embedding", () => backend.promise);
    const diagnostic = queue.snapshot();
    diagnostic.active = 0;
    diagnostic.limits.concurrency = 8;
    diagnostic.limits.maxPending = 256;
    diagnostic.counts.completed = 500;
    diagnostic.stages.query_embedding.counts.cancelled = 500;
    diagnostic.latencyMs.p50 = 500;
    await expect(queue.run("rerank", async () => "overflow")).rejects.toMatchObject({
      code: "inference_overloaded",
    });
    backend.resolve("actual result");
    expect(await running).toBe("actual result");
    expect(queue.snapshot()).toMatchObject({
      active: 0,
      pending: 0,
      limits: { concurrency: 1, maxPending: 0 },
      counts: { completed: 1, failed: 0, cancelled: 0, rejected: 1 },
      latencyMs: { p50: 0, p95: 0, samples: 1 },
      stages: { query_embedding: { counts: { completed: 1, failed: 0, cancelled: 0, rejected: 0 } } },
    });
  });
});
