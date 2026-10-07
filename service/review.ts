import { parseReviewReply } from "../shared/review";
import type { AuditDetail } from "./audit";
import type { MemoryStore } from "./store";

const WINDOW_MS = 15 * 60_000;

export class ReviewCapError extends Error {
  constructor(cap: number) {
    super(
      `This review already saved ${cap} ${cap === 1 ? "memory" : "memories"}, the limit for one review. ` +
        "Update an existing memory with memory_update, or finish the review.",
    );
  }
}

interface ReviewWindow {
  agentId: string;
  nonce: string;
  trigger: string;
  startedAt: string;
  startedMs: number;
  saves: number;
}

export interface ClosedReview {
  nonce: string;
  trigger: string;
  startedAt: string;
  durationMs: number;
}

// A review window is open from review-start until its turn ends; saves inside it count toward the cap.
export class ReviewWindows {
  private readonly byNonce = new Map<string, ReviewWindow>();
  private readonly store: MemoryStore;
  private readonly now: () => Date;

  constructor(store: MemoryStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  open(input: { agentId: string; nonce: string; trigger: string }): void {
    const now = this.now();
    this.byNonce.set(input.nonce, {
      ...input,
      startedAt: now.toISOString(),
      startedMs: now.getTime(),
      saves: 0,
    });
  }

  checkSave(nonce: string | null): void {
    const window = this.active(nonce);
    const cap = this.store.config.reviewMaxMemories;
    if (window && window.saves >= cap) throw new ReviewCapError(cap);
  }

  countSave(nonce: string | null, status: string): void {
    const window = this.active(nonce);
    if (window && (status === "created" || status === "updated")) window.saves++;
  }

  close(agentId: string): ClosedReview | null {
    const window = [...this.byNonce.values()].find((w) => w.agentId === agentId);
    if (!window) return null;
    this.byNonce.delete(window.nonce);
    const { nonce, trigger, startedAt, startedMs } = window;
    return { nonce, trigger, startedAt, durationMs: this.now().getTime() - startedMs };
  }

  private active(nonce: string | null): ReviewWindow | null {
    const window = nonce ? this.byNonce.get(nonce) : undefined;
    if (!window) return null;
    if (this.now().getTime() - window.startedMs <= WINDOW_MS) return window;
    this.byNonce.delete(window.nonce);
    return null;
  }
}

export interface ReviewEnd {
  agentId: string;
  reply: string | null;
  failed: boolean;
}

export interface ReviewOutcome {
  ok: boolean;
  saved: number[];
  updated: number[];
  summary: string | null;
}

export function finishReview(store: MemoryStore, windows: ReviewWindows, end: ReviewEnd): ReviewOutcome {
  const closed = windows.close(end.agentId);
  const nonce = closed?.nonce ?? store.audit.nonceFor(end.agentId);
  const base = { trigger: closed?.trigger ?? "unknown", durationMs: closed?.durationMs ?? null };
  if (end.failed || !end.reply) {
    const reason = end.failed ? "The review turn did not finish." : "The agent did not reply.";
    store.audit.record(nonce, {
      kind: "review",
      ...base,
      status: "failed",
      reason,
      saved: [],
      updated: [],
      summary: null,
    });
    return { ok: false, saved: [], updated: [], summary: null };
  }
  const reply = parseReviewReply(end.reply);
  const touched = closed ? touchedIds(store.audit.eventsSince(closed.nonce, closed.startedAt)) : null;
  const saved = touched?.saved ?? reply.saved;
  const updated = (touched?.updated ?? reply.updated).filter((id) => !saved.includes(id));
  store.storeReview({
    agentId: end.agentId,
    summary: reply.summary,
    outcomes: outcomeText(store, saved, updated),
  });
  store.audit.record(nonce, {
    kind: "review",
    ...base,
    status: "done",
    reason: null,
    saved,
    updated,
    summary: reply.summary,
  });
  return { ok: true, saved, updated, summary: reply.summary };
}

// The audit trail of the review window is the record of what changed; the reply's own list can be wrong.
function touchedIds(events: AuditDetail[]): { saved: number[]; updated: number[] } {
  const saved = new Set<number>();
  const updated = new Set<number>();
  for (const event of events) {
    if (event.kind === "save" && event.id !== null && event.status === "created") saved.add(event.id);
    if (event.kind === "save" && event.id !== null && event.status === "updated") updated.add(event.id);
    if (event.kind === "update" && event.ok) updated.add(event.id);
  }
  return { saved: [...saved], updated: [...updated] };
}

function outcomeText(store: MemoryStore, saved: number[], updated: number[]): string | null {
  const titles = new Map(store.get([...saved, ...updated]).map((row) => [row.id, row.title]));
  const lines = [
    ...saved.map((id) => `Saved #${id}: ${titles.get(id) ?? "deleted"}`),
    ...updated.map((id) => `Updated #${id}: ${titles.get(id) ?? "deleted"}`),
  ];
  return lines.length > 0 ? lines.join("\n") : null;
}
