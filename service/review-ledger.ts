import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

const WINDOW_MS = 15 * 60_000;
const MIN_ATTEMPTS = 20;

export type ReviewOpKind = "save" | "update" | "delete";
export type ReviewLimitCode = "review_cap_reached" | "review_attempt_limit" | "review_closed";

export class ReviewLimitError extends Error {
  readonly code: ReviewLimitCode;

  constructor(code: ReviewLimitCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Reservation {
  nonce: string;
  key: string;
  kind: ReviewOpKind;
  windowId: string;
}

export type Admission =
  | { kind: "unrestricted" }
  | { kind: "granted"; reservation: Reservation }
  | { kind: "replay"; receipt: string | null; memoryId: number | null }
  | { kind: "in_flight"; windowId: string };

export interface ClosedReview {
  windowId: string;
  nonce: string;
  trigger: string;
  startedAt: string;
  durationMs: number | null;
}

export interface ReviewWindowInfo {
  nonce: string;
  agentId: string;
  cap: number;
  committed: number;
  reserved: number;
  attempts: number;
  maxAttempts: number;
  expired: boolean;
}

interface WindowRow {
  nonce: string;
  window_id: string;
  agent_id: string;
  trigger: string;
  cap: number;
  max_attempts: number;
  attempts: number;
  started_at: string;
  expires_at: string;
}

interface OpRow {
  status: "reserved" | "committed" | "completed" | "released";
  memory_id: number | null;
  receipt: string | null;
}

type Decision = { type: "granted" } | { type: "limit"; code: ReviewLimitCode };

/**
 * Admission control for memory changes made during a session review. Every change asks `admit` first, which
 * counts the attempt and reserves a slot in one synchronous step, so concurrent calls cannot share the last slot
 * even while one of them awaits an embedding. The reservation is settled in the same SQLite transaction as the
 * change it paid for, and a retry of the same request replays its receipt instead of using a second slot.
 * State lives in the database so a restart does not reset a running review's cap.
 */
export class ReviewLedger {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, now: () => Date) {
    this.db = db;
    this.now = now;
    this.releaseStale();
  }

  open(input: { agentId: string; nonce: string; trigger: string; cap: number }): string {
    const startedMs = this.now().getTime();
    return this.db.transaction(() => {
      const existing = this.openWindow(input.nonce);
      if (existing) return existing.window_id;
      const windowId = randomUUID();
      this.db
        .query(`UPDATE review_windows SET closed_at = ? WHERE agent_id = ? AND closed_at IS NULL`)
        .run(new Date(startedMs).toISOString(), input.agentId);
      this.db
        .query(
          `INSERT OR REPLACE INTO review_windows
           (nonce, window_id, agent_id, trigger, cap, max_attempts, attempts, started_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          input.nonce,
          windowId,
          input.agentId,
          input.trigger,
          input.cap,
          Math.max(MIN_ATTEMPTS, input.cap * 2),
          new Date(startedMs).toISOString(),
          new Date(startedMs + WINDOW_MS).toISOString(),
        );
      this.db.query(`DELETE FROM review_ops WHERE nonce = ?`).run(input.nonce);
      return windowId;
    })();
  }

  admit(nonce: string | null, key: string, kind: ReviewOpKind): Admission {
    if (!nonce) return { kind: "unrestricted" };
    const admission = this.db.transaction(
      (): Admission | { kind: "limit"; code: ReviewLimitCode; window: WindowRow } => {
        const window = this.openWindow(nonce);
        if (!window) return { kind: "unrestricted" };
        const previous = this.op(nonce, key);
        if (previous?.status === "committed" || previous?.status === "completed") {
          return { kind: "replay", receipt: previous.receipt, memoryId: previous.memory_id };
        }
        if (previous?.status === "reserved") return { kind: "in_flight", windowId: window.window_id };
        const reservation = { nonce, key, kind, windowId: window.window_id };
        const decision = this.decide(window, reservation);
        if (decision.type === "limit") return { kind: "limit", code: decision.code, window };
        return { kind: "granted", reservation };
      },
    )();
    if (admission.kind === "limit") throw limitError(admission.code, admission.window);
    return admission;
  }

  assertActive(reservation: Reservation): void {
    const window = this.openWindow(reservation.nonce);
    if (
      !window ||
      window.window_id !== reservation.windowId ||
      this.expired(window) ||
      this.op(reservation.nonce, reservation.key)?.status !== "reserved"
    ) {
      throw new ReviewLimitError("review_closed", "This review is closed. Finish the review now.");
    }
  }

  rejectAttempt(nonce: string | null): void {
    const result = this.db.transaction(() => {
      const window = nonce ? this.openWindow(nonce) : null;
      return window ? { code: this.countAttempt(window), window } : null;
    })();
    if (result?.code) throw limitError(result.code, result.window);
  }

  settle(
    reservation: Reservation,
    outcome: { consumed: boolean; memoryId: number | null; receipt?: string },
  ): void {
    this.db
      .query(
        `UPDATE review_ops SET status = ?, memory_id = ?, settled_at = ?, receipt = ?
         WHERE nonce = ? AND request_key = ? AND status = 'reserved'`,
      )
      .run(
        outcome.consumed ? "committed" : "completed",
        outcome.memoryId,
        this.now().toISOString(),
        outcome.receipt ?? null,
        reservation.nonce,
        reservation.key,
      );
  }

  release(reservation: Reservation): void {
    this.db
      .query(`UPDATE review_ops SET status = 'released', settled_at = ?
        WHERE nonce = ? AND request_key = ? AND status = 'reserved'
        AND EXISTS (SELECT 1 FROM review_windows WHERE nonce = ? AND window_id = ?)`)
      .run(
        this.now().toISOString(),
        reservation.nonce,
        reservation.key,
        reservation.nonce,
        reservation.windowId,
      );
  }

  attachReceipt(reservation: Reservation, receipt: string): void {
    this.db
      .query(`UPDATE review_ops SET receipt = ?, status = CASE WHEN status = 'reserved' THEN 'completed' ELSE status END
        WHERE nonce = ? AND request_key = ?
        AND EXISTS (SELECT 1 FROM review_windows WHERE nonce = ? AND window_id = ?)`)
      .run(receipt, reservation.nonce, reservation.key, reservation.nonce, reservation.windowId);
  }

  close(agentId: string): ClosedReview | null {
    const window = this.db
      .query<WindowRow, [string]>(`SELECT * FROM review_windows WHERE agent_id = ? AND closed_at IS NULL`)
      .get(agentId);
    if (!window) return null;
    const now = this.now();
    const durationMs = now.getTime() - Date.parse(window.started_at);
    this.db
      .query(`UPDATE review_windows SET closed_at = ? WHERE nonce = ?`)
      .run(now.toISOString(), window.nonce);
    return {
      windowId: window.window_id,
      nonce: window.nonce,
      trigger: window.trigger,
      startedAt: window.started_at,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
    };
  }

  info(nonce: string): ReviewWindowInfo | null {
    const window = this.openWindow(nonce);
    if (!window) return null;
    const counts = this.counts(nonce);
    return {
      nonce,
      agentId: window.agent_id,
      cap: window.cap,
      committed: counts.committed,
      reserved: counts.reserved,
      attempts: window.attempts,
      maxAttempts: window.max_attempts,
      expired: this.expired(window),
    };
  }

  // Reservations cannot outlive the process that awaited for them, so a restart gives their slots back.
  private releaseStale(): void {
    this.db
      .query(`UPDATE review_ops SET status = 'released', settled_at = ? WHERE status = 'reserved'`)
      .run(this.now().toISOString());
  }

  private decide(window: WindowRow, request: Reservation): Decision {
    const code = this.countAttempt(window);
    if (code) return { type: "limit", code };
    if (window.cap === 0 || request.kind !== "delete") {
      const { committed, reserved } = this.counts(window.nonce);
      if (committed + reserved >= window.cap) return { type: "limit", code: "review_cap_reached" };
    }
    this.db
      .query(
        `INSERT INTO review_ops (nonce, request_key, kind, status, created_at) VALUES (?, ?, ?, 'reserved', ?)
         ON CONFLICT(nonce, request_key) DO UPDATE SET status = 'reserved', kind = excluded.kind,
           memory_id = NULL, receipt = NULL, settled_at = NULL`,
      )
      .run(request.nonce, request.key, request.kind, this.now().toISOString());
    return { type: "granted" };
  }

  private countAttempt(window: WindowRow): ReviewLimitCode | null {
    if (this.expired(window)) return "review_closed";
    if (window.attempts >= window.max_attempts) return "review_attempt_limit";
    this.db.query(`UPDATE review_windows SET attempts = attempts + 1 WHERE nonce = ?`).run(window.nonce);
    return null;
  }

  private openWindow(nonce: string): WindowRow | null {
    return this.db
      .query<WindowRow, [string]>(`SELECT * FROM review_windows WHERE nonce = ? AND closed_at IS NULL`)
      .get(nonce);
  }

  private expired(window: WindowRow): boolean {
    return this.now().getTime() >= Date.parse(window.expires_at);
  }

  private counts(nonce: string): { committed: number; reserved: number } {
    const rows = this.db
      .query<{ status: string; n: number }, [string]>(
        `SELECT status, count(*) AS n FROM review_ops
         WHERE nonce = ? AND kind IN ('save', 'update') AND status IN ('reserved', 'committed') GROUP BY status`,
      )
      .all(nonce);
    const of = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
    return { committed: of("committed"), reserved: of("reserved") };
  }

  private op(nonce: string, key: string): OpRow | null {
    return this.db
      .query<OpRow, [string, string]>(
        `SELECT status, memory_id, receipt FROM review_ops WHERE nonce = ? AND request_key = ?`,
      )
      .get(nonce, key);
  }
}

function limitError(code: ReviewLimitCode, window: WindowRow): ReviewLimitError {
  if (code === "review_closed") {
    return new ReviewLimitError(
      code,
      "This review ran past its 15 minute window, so memory changes are blocked until the review turn ends. " +
        "Reply with the summary now.",
    );
  }
  if (code === "review_attempt_limit") {
    return new ReviewLimitError(
      code,
      `This review already made ${window.attempts} memory calls, the most one review may try. Finish the review now.`,
    );
  }
  if (window.cap === 0) {
    return new ReviewLimitError(code, "Memory changes are turned off for reviews. Only write the summary.");
  }
  return new ReviewLimitError(
    code,
    `This review already made ${window.cap} memory ${window.cap === 1 ? "change" : "changes"}, the limit for ` +
      "one review. A new memory or an update each counts as one. Finish the review now.",
  );
}
