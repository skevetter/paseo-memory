// Extract a compact, redacted turn digest from the Paseo timeline (no tool output, no reasoning).

import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export interface TurnDigest {
  userText: string | null;
  assistantText: string | null;
  files: string[];
}

export function digestLatestTurn(timeline: readonly AgentTimelineItem[]): TurnDigest {
  let start = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === "user_message") {
      start = i;
      break;
    }
  }
  let userText: string | null = null;
  const replies: string[] = [];
  const files = new Set<string>();
  for (const item of timeline.slice(start)) {
    if (item.type === "user_message") userText = item.text;
    else if (item.type === "assistant_message" && item.text.trim()) replies.push(item.text);
    else if (item.type === "tool_call") {
      const detail = item.detail as { type?: string; filePath?: string } | undefined;
      if (detail && (detail.type === "edit" || detail.type === "write") && detail.filePath) files.add(detail.filePath);
    }
  }
  // The last assistant message is normally the turn's conclusion.
  const assistantText = replies.length ? replies[replies.length - 1] : null;
  return { userText, assistantText, files: [...files] };
}
