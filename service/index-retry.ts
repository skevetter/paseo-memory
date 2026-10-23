export interface IndexRetryOptions {
  baseMs: number;
  maxAttempts: number;
  /** Runs `run` after `delayMs`; tests replace it to control the clock. */
  schedule?: (run: () => void, delayMs: number) => void;
}

export interface IndexHealth {
  pending: number;
  retrying: number;
  failed: number;
  degraded: boolean;
  lastError: string | null;
}

export const DEFAULT_INDEX_RETRY: IndexRetryOptions = { baseMs: 2000, maxAttempts: 5 };

const MAX_DELAY_MS = 60_000;

interface Failure {
  generation: number;
  attempts: number;
  state: "waiting" | "ready" | "exhausted";
}

interface Attempt {
  id: number;
  index_generation: number;
}

// Failed embeddings stay pending in the database; this only decides when a row may be tried again.
// A row that is edited gets a new generation and therefore a fresh set of attempts.
export class IndexRetry {
  private readonly failures = new Map<number, Failure>();
  private readonly options: IndexRetryOptions;
  private lastError: string | null = null;

  constructor(options: IndexRetryOptions = DEFAULT_INDEX_RETRY) {
    this.options = options;
  }

  canAttempt(row: Attempt): boolean {
    const failure = this.failures.get(row.id);
    return !failure || failure.generation !== row.index_generation || failure.state === "ready";
  }

  succeeded(id: number): void {
    this.failures.delete(id);
  }

  clear(): void {
    this.failures.clear();
    this.lastError = null;
  }

  /** Records a failed attempt for every row and schedules one retry for the rows that still have attempts left. */
  failed(rows: Attempt[], error: string, retry: () => void): void {
    this.lastError = error;
    const waiting: number[] = [];
    let attempts = 0;
    for (const row of rows) {
      const previous = this.failures.get(row.id);
      const count = previous?.generation === row.index_generation ? previous.attempts + 1 : 1;
      const exhausted = count >= this.options.maxAttempts;
      this.failures.set(row.id, {
        generation: row.index_generation,
        attempts: count,
        state: exhausted ? "exhausted" : "waiting",
      });
      if (!exhausted) waiting.push(row.id);
      attempts = Math.max(attempts, count);
    }
    if (waiting.length === 0) return;
    const delay = Math.min(MAX_DELAY_MS, this.options.baseMs * 2 ** (attempts - 1));
    const schedule = this.options.schedule ?? defaultSchedule;
    schedule(() => {
      for (const id of waiting) {
        const failure = this.failures.get(id);
        if (failure?.state === "waiting") failure.state = "ready";
      }
      retry();
    }, delay);
  }

  /** Counts failures that still apply to the row's current generation; `current` reports that generation. */
  summary(current: (id: number) => number | null): Pick<IndexHealth, "retrying" | "failed" | "lastError"> {
    let retrying = 0;
    let failed = 0;
    for (const [id, failure] of this.failures) {
      if (current(id) !== failure.generation) this.failures.delete(id);
      else if (failure.state === "exhausted") failed++;
      else retrying++;
    }
    return { retrying, failed, lastError: retrying + failed > 0 ? this.lastError : null };
  }
}

function defaultSchedule(run: () => void, delayMs: number): void {
  const timer = setTimeout(run, delayMs);
  timer.unref();
}
