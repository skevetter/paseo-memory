import {
  INFERENCE_LATENCY_HISTORY_LIMIT,
  INFERENCE_QUEUE_DEFAULTS,
  INFERENCE_QUEUE_HARD_LIMITS,
  type InferenceQueueCounts,
  type InferenceQueueSnapshot,
  type InferenceStage,
  type InferenceStageSnapshot,
} from "../shared/inference";

export type InferenceQueueErrorCode = "inference_overloaded" | "inference_cancelled" | "inference_closed";

const errorMessages: Record<InferenceQueueErrorCode, string> = {
  inference_overloaded: "Local inference capacity is exhausted.",
  inference_cancelled: "Local inference was cancelled.",
  inference_closed: "The local inference queue is closed.",
};

export class InferenceQueueError extends Error {
  constructor(
    readonly code: InferenceQueueErrorCode,
    message = errorMessages[code],
  ) {
    super(message);
    this.name = "InferenceQueueError";
  }
}

export interface InferenceQueueOptions {
  concurrency?: number;
  maxPending?: number;
  now?: () => number;
}

export interface InferenceRunOptions {
  signal?: AbortSignal;
}

type Outcome = keyof InferenceQueueCounts;

export class InferenceMetrics {
  private readonly counts: InferenceQueueCounts = { completed: 0, failed: 0, cancelled: 0, rejected: 0 };
  private readonly samples: number[] = [];
  private nextSample = 0;

  record(outcome: Outcome, elapsedMs: number): void {
    this.counts[outcome]++;
    if (outcome === "rejected") return;
    if (this.samples.length < INFERENCE_LATENCY_HISTORY_LIMIT) this.samples.push(elapsedMs);
    else this.samples[this.nextSample] = elapsedMs;
    this.nextSample = (this.nextSample + 1) % INFERENCE_LATENCY_HISTORY_LIMIT;
  }

  snapshot(): InferenceStageSnapshot {
    const sorted = this.samples.toSorted((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
    return {
      counts: { ...this.counts },
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), samples: sorted.length },
    };
  }
}

interface QueuedInference {
  readonly queuedAt: number;
  start(): void;
  cancel(error: InferenceQueueError): void;
}

function boundedLimit(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export class InferenceQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly pending: QueuedInference[] = [];
  private readonly active = new Set<QueuedInference>();
  private readonly totals = new InferenceMetrics();
  private readonly stages: Record<InferenceStage, InferenceMetrics> = {
    document_embedding: new InferenceMetrics(),
    query_embedding: new InferenceMetrics(),
    rerank: new InferenceMetrics(),
  };
  private closed = false;

  constructor(options: InferenceQueueOptions = {}) {
    const {
      concurrency = INFERENCE_QUEUE_DEFAULTS.concurrency,
      maxPending = INFERENCE_QUEUE_DEFAULTS.maxPending,
      now = () => performance.now(),
    } = options;
    this.concurrency = boundedLimit("concurrency", concurrency, 1, INFERENCE_QUEUE_HARD_LIMITS.concurrency);
    this.maxPending = boundedLimit("maxPending", maxPending, 0, INFERENCE_QUEUE_HARD_LIMITS.maxPending);
    this.now = now;
  }

  run<T>(
    stage: InferenceStage,
    work: (signal: AbortSignal) => Promise<T>,
    options: InferenceRunOptions = {},
  ): Promise<T> {
    this.dispatch();
    if (this.closed) return this.refuse(stage, "inference_closed");
    if (options.signal?.aborted) {
      this.record(stage, "cancelled", 0);
      return Promise.reject(new InferenceQueueError("inference_cancelled"));
    }
    if (this.active.size >= this.concurrency && this.pending.length >= this.maxPending) {
      return this.refuse(stage, "inference_overloaded");
    }
    const { entry, promise } = this.prepare(stage, work, options.signal);
    if (this.active.size < this.concurrency) this.start(entry);
    else this.pending.push(entry);
    return promise;
  }

  cancelPending(reason?: string): number {
    const pending = this.pending.splice(0);
    for (const entry of pending) entry.cancel(new InferenceQueueError("inference_cancelled", reason));
    return pending.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new InferenceQueueError("inference_closed");
    for (const entry of this.pending.splice(0)) entry.cancel(error);
    for (const entry of this.active) entry.cancel(error);
  }

  snapshot(): InferenceQueueSnapshot {
    const oldest = this.pending[0];
    return {
      active: this.active.size,
      pending: this.pending.length,
      oldestQueuedMs: oldest ? Math.max(1, Math.ceil(this.now() - oldest.queuedAt)) : 0,
      limits: { concurrency: this.concurrency, maxPending: this.maxPending },
      ...this.totals.snapshot(),
      stages: {
        document_embedding: this.stages.document_embedding.snapshot(),
        query_embedding: this.stages.query_embedding.snapshot(),
        rerank: this.stages.rerank.snapshot(),
      },
    };
  }

  private refuse<T>(stage: InferenceStage, code: InferenceQueueErrorCode): Promise<T> {
    this.record(stage, "rejected", 0);
    return Promise.reject(new InferenceQueueError(code));
  }

  private record(stage: InferenceStage, outcome: Outcome, elapsedMs: number): void {
    this.totals.record(outcome, elapsedMs);
    this.stages[stage].record(outcome, elapsedMs);
  }

  private prepare<T>(stage: InferenceStage, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const controller = new AbortController();
    const queuedAt = this.now();
    let settled = false;
    const settle = (outcome: Outcome) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      this.record(stage, outcome, Math.max(0, this.now() - queuedAt));
      return true;
    };
    const entry: QueuedInference = {
      queuedAt,
      start: () => {
        let backend: Promise<T>;
        try {
          backend = work(controller.signal);
        } catch (error) {
          backend = Promise.reject(error);
        }
        void Promise.resolve(backend).then(
          (value) => {
            if (settle("completed")) resolve(value);
            this.finish(entry);
          },
          (error: unknown) => {
            const cancelled =
              error instanceof InferenceQueueError &&
              (error.code === "inference_cancelled" || error.code === "inference_closed");
            if (settle(cancelled ? "cancelled" : "failed")) reject(error);
            this.finish(entry);
          },
        );
      },
      cancel: (error) => {
        if (!settle("cancelled")) return;
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        reject(error);
        controller.abort(error);
        this.dispatch();
      },
    };
    const onAbort = () => entry.cancel(new InferenceQueueError("inference_cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    return { entry, promise };
  }

  private start(entry: QueuedInference): void {
    this.active.add(entry);
    entry.start();
  }

  private finish(entry: QueuedInference): void {
    this.active.delete(entry);
    this.dispatch();
  }

  private dispatch(): void {
    while (!this.closed && this.active.size < this.concurrency) {
      const entry = this.pending.shift();
      if (!entry) return;
      this.start(entry);
    }
  }
}
