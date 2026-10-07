// Links the nonce in each agent's memory token to the Paseo agent id.
//
// before("agent.create") runs before Paseo assigns the agent id. The service mints a nonce,
// signs it into the agent's token, and the hook also puts it in the launch environment.
// before("agent.session_open") with reason "create" carries both that environment and the agent
// id, which gives an exact link. When the environment does not carry the nonce, agent.created and
// the first agent.turn_ended fall back to the oldest unclaimed nonce with the same cwd and
// provider from the last two minutes.

const MATCH_WINDOW_MS = 120_000;
const MAX_PENDING = 200;
const MAX_LINKED = 5000;

interface Pending {
  nonce: string;
  cwd: string;
  provider: string;
  at: number;
}

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

  // Exact link: the nonce came back with its agent id.
  claim(nonce: string, agentId: string): void {
    this.pending = this.pending.filter((p) => p.nonce !== nonce);
    this.markLinked(agentId);
  }

  // Fallback link for an agent that has none yet. Returns the nonce to link, or null.
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
