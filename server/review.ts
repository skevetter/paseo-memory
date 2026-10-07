export type ReviewMode = "off" | "idle" | "turns";
export type ReviewTrigger = "idle" | "turns";
export type TurnResult = "completed" | "failed" | "canceled";

export const MIN_REVIEW_TURNS = 2;
// Every-N reviews still wait a moment so a user who is typing the next message gets there first.
const TURNS_SETTLE_MS = 5000;

export interface ReviewPolicy {
  mode: ReviewMode;
  idleMs: number;
  everyTurns: number;
}

export interface SchedulerDeps {
  policy(): ReviewPolicy;
  fire(agentId: string, trigger: ReviewTrigger): void;
  setTimer(run: () => void, ms: number): () => void;
}

interface AgentState {
  turns: number;
  cancelTimer: (() => void) | null;
  reviewing: boolean;
}

// Timer state lives only in the plugin process; a daemon restart drops pending reviews.
export class ReviewScheduler {
  private readonly agents = new Map<string, AgentState>();
  private readonly deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  turnStarted(agentId: string): void {
    this.cancel(this.agents.get(agentId));
  }

  turnEnded(agentId: string, result: TurnResult): string {
    const state = this.state(agentId);
    this.cancel(state);
    if (state.reviewing) return "a review is running";
    if (result !== "completed") return `the last turn ${result === "failed" ? "failed" : "was canceled"}`;
    state.turns++;
    return this.schedule(agentId, state);
  }

  reviewStarted(agentId: string): void {
    const state = this.state(agentId);
    this.cancel(state);
    state.reviewing = true;
  }

  reviewSkipped(agentId: string): void {
    this.state(agentId).reviewing = false;
  }

  reviewEnded(agentId: string): void {
    const state = this.state(agentId);
    state.reviewing = false;
    state.turns = 0;
  }

  forget(agentId: string): void {
    this.cancel(this.agents.get(agentId));
    this.agents.delete(agentId);
  }

  pending(agentId: string): boolean {
    return Boolean(this.agents.get(agentId)?.cancelTimer);
  }

  private schedule(agentId: string, state: AgentState): string {
    const policy = this.deps.policy();
    if (policy.mode === "off") return "reviews are off";
    if (state.turns < MIN_REVIEW_TURNS) {
      return `${state.turns} completed ${state.turns === 1 ? "turn" : "turns"}, needs ${MIN_REVIEW_TURNS}`;
    }
    if (policy.mode === "turns" && state.turns < policy.everyTurns) {
      return `${state.turns} of ${policy.everyTurns} turns`;
    }
    const trigger: ReviewTrigger = policy.mode;
    const delay = trigger === "idle" ? policy.idleMs : TURNS_SETTLE_MS;
    state.cancelTimer = this.deps.setTimer(() => {
      state.cancelTimer = null;
      if (state.reviewing) return;
      state.reviewing = true;
      this.deps.fire(agentId, trigger);
    }, delay);
    return `review in ${Math.round(delay / 1000)} s if idle`;
  }

  private state(agentId: string): AgentState {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const created: AgentState = { turns: 0, cancelTimer: null, reviewing: false };
    this.agents.set(agentId, created);
    return created;
  }

  private cancel(state: AgentState | undefined): void {
    if (!state?.cancelTimer) return;
    state.cancelTimer();
    state.cancelTimer = null;
  }
}
