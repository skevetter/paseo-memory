import type { ReviewDisplay } from "./service-api";

const PROMPT_MARKER = /^\s*\[paseo-memory:review v1(?: (collapsed|full|hidden))?\]/;
const REPLY_MARKER = /^\s*\[paseo-memory:review-reply v1(?: (collapsed|full|hidden))?\]/;
const REPLY_MARKER_TEXT = "[paseo-memory:review-reply v1";
const OUTCOME_LINE = /^\s*(saved|updated)\s*:(.*)$/i;
const NOTHING_LINE = /^\s*nothing to save\.?\s*$/i;

export interface ReviewReply {
  display: ReviewDisplay;
  summary: string | null;
  saved: number[];
  updated: number[];
  nothingToSave: boolean;
}

export function reviewPrompt(input: { cap: number; display: ReviewDisplay }): string {
  const limit =
    input.cap === 0
      ? "Do not save or update any memory in this review; only write the summary."
      : `Save or update at most ${input.cap} durable ${input.cap === 1 ? "memory" : "memories"}: decisions, root causes, conventions, config, and user corrections. Prefer memory_update or a topic_key over a new memory. Write content as What / Why / Where / Learned in under 800 characters. Never save secrets, credentials, transcripts, or customer data. Saving nothing is fine.`;
  return [
    `[paseo-memory:review v1 ${input.display}]`,
    "This is an automatic memory review from paseo-memory, not a request from the user. Do not edit files or run commands other than the memory tools.",
    "1. Call memory_search for the main topics of this session before you save anything.",
    `2. ${limit}`,
    "3. Reply in exactly this format and nothing else:",
    `${REPLY_MARKER_TEXT} ${input.display}]`,
    "Summary: <one paragraph on what this session did, decided and learned>",
    "Saved: #<id>, #<id>   (or Saved: none)",
    "Updated: #<id>   (or Updated: none)",
    'If nothing was worth saving, write "Nothing to save" in place of the Saved and Updated lines.',
  ].join("\n");
}

export function reviewPromptDisplay(text: string): ReviewDisplay | null {
  const match = PROMPT_MARKER.exec(text);
  if (!match) return null;
  return toDisplay(match[1]);
}

export function isReviewReply(text: string): boolean {
  return REPLY_MARKER.test(text);
}

// A streaming reply can stop partway through the marker, so a prefix of it counts as a review reply.
export function isPartialReviewReply(text: string): boolean {
  const head = text.trimStart();
  return head.length > 0 && REPLY_MARKER_TEXT.startsWith(head.slice(0, REPLY_MARKER_TEXT.length));
}

export function parseReviewReply(text: string): ReviewReply {
  const display = toDisplay(REPLY_MARKER.exec(text)?.[1]);
  const reply: ReviewReply = { display, summary: null, saved: [], updated: [], nothingToSave: false };
  const summary: string[] = [];
  for (const line of text.replace(REPLY_MARKER, "").split("\n")) {
    if (!readOutcome(line, reply) && line.trim()) {
      summary.push(line.trim().replace(/^summary\s*:\s*/i, ""));
    }
  }
  reply.summary = summary.join(" ").trim() || null;
  return reply;
}

function readOutcome(line: string, reply: ReviewReply): boolean {
  if (NOTHING_LINE.test(line)) {
    reply.nothingToSave = true;
    return true;
  }
  const outcome = OUTCOME_LINE.exec(line);
  if (!outcome) return false;
  const ids = [...(outcome[2] ?? "").matchAll(/#?(\d+)/g)].map((m) => Number(m[1]));
  reply[outcome[1]?.toLowerCase() === "saved" ? "saved" : "updated"].push(...ids);
  return true;
}

export function reviewHeadline(reply: Pick<ReviewReply, "saved" | "updated">): string {
  const parts = [
    reply.saved.length > 0 ? `saved ${reply.saved.map((id) => `#${id}`).join(", ")}` : null,
    reply.updated.length > 0 ? `updated ${reply.updated.map((id) => `#${id}`).join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return `Memory review: ${parts.length > 0 ? parts.join(", ") : "nothing new"}`;
}

function toDisplay(value: string | undefined): ReviewDisplay {
  return value === "full" || value === "hidden" ? value : "collapsed";
}
