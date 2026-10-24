import { parseReviewReply } from "../shared/review";
import type { ServiceParsedInput } from "../shared/service-api";
import { Access } from "./access";
import type { AuditDetail } from "./audit";
import type { MemoryStore } from "./store";

export type ReviewEnd = ServiceParsedInput<"review-end">;

export interface ReviewOutcome {
  ok: boolean;
  saved: number[];
  updated: number[];
  summary: string | null;
}

export function finishReview(store: MemoryStore, end: ReviewEnd): ReviewOutcome {
  if (store.sessionInvalidated(end.agentId)) return { ok: false, saved: [], updated: [], summary: null };
  const { closed, nonce, base } = closeReview(store, end);
  if (end.outcome !== "completed" || !end.reply) {
    const reason =
      end.outcome !== "completed" ? "The review turn did not finish." : "The agent did not reply.";
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

function closeReview(store: MemoryStore, end: ReviewEnd) {
  const closed = store.closeReviewWindow(end);
  return {
    closed,
    nonce: closed?.nonce ?? store.audit.nonceFor(end.agentId),
    base: { trigger: closed?.trigger ?? "unknown", durationMs: closed?.durationMs ?? null },
  };
}

// The audit trail of the review window is the record of what changed; the reply's own list can be wrong.
function touchedIds(events: AuditDetail[]): { saved: number[]; updated: number[] } {
  const saved = new Set<number>();
  const updated = new Set<number>();
  for (const event of events) {
    if (event.kind === "save" && event.id !== null && event.status === "created") saved.add(event.id);
    if (event.kind === "save" && event.id !== null && event.status === "updated") updated.add(event.id);
    if (event.kind === "update" && event.ok && !event.unchanged) updated.add(event.id);
  }
  return { saved: [...saved], updated: [...updated] };
}

function outcomeText(store: MemoryStore, saved: number[], updated: number[]): string | null {
  const titles = new Map(
    [...saved, ...updated].flatMap((id) => {
      const detail = store.lifecycleDetail(Access.owner(), id);
      const current = detail?.revisions.find((revision) => revision.revision === detail.memoryRef.revision);
      return current ? [[id, String(current.snapshot.title ?? "")] as const] : [];
    }),
  );
  const lines = [
    ...saved.map((id) => `Saved #${id}: ${titles.get(id) ?? "deleted"}`),
    ...updated.map((id) => `Updated #${id}: ${titles.get(id) ?? "deleted"}`),
  ];
  return lines.length > 0 ? lines.join("\n") : null;
}
