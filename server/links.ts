const MATCH_WINDOW_MS = 120_000;
const MAX_PENDING = 200;
const MAX_LINKED = 5000;

interface Pending {
  nonce: string;
  cwd: string;
  provider: string;
  at: number;
}

// agent.create runs before Paseo assigns the agent id, so its nonce waits here until a later hook links it.
export class AgentLinks {
  private pending: Pending[] = [];
  private readonly linked = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(nonce: string, cwd: string, provider: string): void {
    this.pending.push({ nonce, cwd, provider, at: this.now() });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  claim(nonce: string, agentId: string): void {
    this.pending = this.pending.filter((p) => p.nonce !== nonce);
    this.markLinked(agentId);
  }

  match(agentId: string, cwd: string, provider: string): string | null {
    if (this.linked.has(agentId)) return null;
    const cutoff = this.now() - MATCH_WINDOW_MS;
    this.pending = this.pending.filter((p) => p.at >= cutoff);
    const found = this.pending.find((p) => p.cwd === cwd && p.provider === provider);
    if (!found) return null;
    this.claim(found.nonce, agentId);
    return found.nonce;
  }

  private markLinked(agentId: string): void {
    if (this.linked.size >= MAX_LINKED) this.linked.clear();
    this.linked.add(agentId);
  }
}
