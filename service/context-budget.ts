import { randomUUID } from "node:crypto";
import type { MemoryRef } from "../shared/lifecycle";
import type { RetrievalBudget, RetrievalResult } from "../shared/retrieval";

/** Counts only this serialized fragment, without implicit per-request BOS/tool framing. */
export interface ContextTokenizer {
  readonly id: string;
  count(text: string): number;
}

export interface ContextEntry {
  key: string;
  memoryRef: MemoryRef | null;
  sessionId: string | null;
  evidenceRefs: string[];
  text: string;
  section: string;
  priority: number;
  score: number;
  diversityKey: string;
  pinned: boolean;
  task: boolean;
  truncated: boolean;
}

interface Measurement {
  chars: number;
  bytes: number;
  tokenCount: number;
}

export interface ContextBudgetInput {
  limits: RetrievalBudget;
  reservedTokens: number;
  reservedChars: number;
  reservedBytes: number;
  policyRevision: number;
  indexGeneration: number;
  tokenizer?: ContextTokenizer;
  prefix?: string;
  totalPins?: number;
  fallbackReason?: string | null;
  latencyMs?: number;
  render(entries: readonly ContextEntry[], omittedPins: number): string;
}

export class ContextBudget {
  private tokenizer: ContextTokenizer | undefined;
  private tokenizerFailed = false;
  private pinTotal = 0;
  private readonly available: Measurement;

  constructor(private readonly input: ContextBudgetInput) {
    this.tokenizer = input.tokenizer;
    this.available = {
      chars: Math.max(0, input.limits.maxChars - input.reservedChars),
      bytes: Math.max(0, input.limits.maxBytes - input.reservedBytes),
      tokenCount: Math.max(0, input.limits.maxTokens - input.reservedTokens),
    };
  }

  pack(entries: readonly ContextEntry[]): RetrievalResult {
    const candidates = [...new Map(entries.map((entry) => [entry.key, entry])).values()];
    this.pinTotal = this.input.totalPins ?? candidates.filter((entry) => entry.pinned).length;
    const selected: ContextEntry[] = [];
    const groups = new Map<string, number>();
    const pending = [...candidates];
    while (pending.length > 0 && selected.length < this.input.limits.maxItems) {
      const next = takeDiverse(pending, groups);
      if (!next) break;
      const attempt = [...selected, next];
      if (!this.fits(this.assembled(this.render(attempt)))) continue;
      selected.push(next);
      groups.set(next.diversityKey, (groups.get(next.diversityKey) ?? 0) + 1);
    }
    return this.finish(candidates, selected);
  }

  private render(selected: readonly ContextEntry[]): string {
    if (selected.length === 0) return "";
    return this.input.render(selected, Math.max(0, this.pinTotal - selected.filter((e) => e.pinned).length));
  }

  private finish(candidates: readonly ContextEntry[], selected: ContextEntry[]): RetrievalResult {
    for (;;) {
      const tokenizer = this.tokenizer;
      const result = this.result(candidates, selected);
      const fits = this.fits(this.assembled(result.contextText));
      if (tokenizer !== this.tokenizer) return this.pack(candidates);
      if (fits || selected.length === 0) return result;
      selected.pop();
    }
  }

  private fallbackReason(contextText: string, hasCandidates: boolean): string | null {
    if (!contextText && !this.fits(this.input.prefix ?? "")) return "preexisting_prompt_exceeds_allowance";
    if (this.input.fallbackReason) return this.input.fallbackReason;
    if (this.tokenizerFailed) return "tokenizer_failed";
    return hasCandidates && !contextText ? "insufficient_allowance" : null;
  }

  private assembled(text: string): string {
    const prefix = this.input.prefix ?? "";
    return prefix && text ? `${prefix}\n\n${text}` : prefix || text;
  }

  private fits(text: string): boolean {
    if (text.length > this.available.chars) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes <= this.available.bytes && this.measure(text, bytes).tokenCount <= this.available.tokenCount;
  }

  private measure(text: string, bytes = Buffer.byteLength(text, "utf8")): Measurement {
    if (text.length === 0) return { chars: 0, bytes, tokenCount: 0 };
    if (this.tokenizer) {
      try {
        const tokenCount = this.tokenizer.count(text);
        if (!Number.isSafeInteger(tokenCount) || tokenCount < 1) throw new Error("Invalid tokenizer count");
        return { chars: text.length, bytes, tokenCount };
      } catch {
        this.tokenizer = undefined;
        this.tokenizerFailed = true;
      }
    }
    // UTF-8 byte fallback is a conservative upper bound for byte-fallback provider tokenizers, not chars/4.
    return { chars: text.length, bytes, tokenCount: bytes };
  }

  private result(candidates: readonly ContextEntry[], selected: readonly ContextEntry[]): RetrievalResult {
    const contextText = this.render(selected);
    const counts = this.measure(contextText);
    const assembled = this.measure(this.assembled(contextText));
    const pins = this.pinTotal;
    const omittedPins = Math.max(0, pins - selected.filter((entry) => entry.pinned).length);
    const omittedCount =
      candidates.length - selected.length + Math.max(0, pins - candidates.filter((e) => e.pinned).length);
    return {
      retrievalId: randomUUID(),
      contextText,
      memoryRefs: selected.flatMap((entry) => (entry.memoryRef ? [entry.memoryRef] : [])),
      evidenceRefs: [...new Set(selected.flatMap((entry) => entry.evidenceRefs))],
      sessionIds: selected.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])),
      taskIds: selected.flatMap((entry) => (entry.task && entry.memoryRef ? [entry.memoryRef.id] : [])),
      usage: {
        ...counts,
        assembledChars: assembled.chars,
        assembledBytes: assembled.bytes,
        assembledTokenCount: assembled.tokenCount,
        tokenCountIsEstimate: !this.tokenizer,
        estimator: this.tokenizer?.id ?? "utf8-byte-upper-bound",
        latencyMs: this.input.latencyMs ?? 0,
        reservedTokens: this.input.reservedTokens,
        reservedChars: this.input.reservedChars,
        reservedBytes: this.input.reservedBytes,
      },
      truncated: omittedCount > 0 || selected.some((entry) => entry.truncated),
      omittedCount,
      omittedPins,
      fallbackReason: this.fallbackReason(contextText, candidates.length > 0),
      policyRevision: this.input.policyRevision,
      indexGeneration: this.input.indexGeneration,
    };
  }
}

function takeDiverse(entries: ContextEntry[], groups: ReadonlyMap<string, number>): ContextEntry | undefined {
  let best = 0;
  for (let index = 1; index < entries.length; index++) {
    const candidate = entries[index],
      prior = entries[best];
    if (!candidate || !prior) continue;
    if (preferred(candidate, prior, groups)) best = index;
  }
  return entries.splice(best, 1)[0];
}

function preferred(
  candidate: ContextEntry,
  prior: ContextEntry,
  groups: ReadonlyMap<string, number>,
): boolean {
  if (candidate.priority !== prior.priority) return candidate.priority < prior.priority;
  const score = candidate.score / (1 + (groups.get(candidate.diversityKey) ?? 0));
  const priorScore = prior.score / (1 + (groups.get(prior.diversityKey) ?? 0));
  return score === priorScore ? candidate.key < prior.key : score > priorScore;
}

export function clipUnicode(text: string, maxChars: number): { text: string; truncated: boolean } {
  const safe = text.toWellFormed();
  if (safe.length <= maxChars) return { text: safe, truncated: false };
  if (maxChars < 3) return { text: "".padEnd(Math.max(0, maxChars), "."), truncated: true };
  let end = maxChars - 3;
  const last = safe.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: `${safe.slice(0, end)}...`, truncated: true };
}
