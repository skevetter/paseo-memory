import type { AgentTimelineItem } from "./host-types";

export interface TurnDigest {
  userText: string | null;
  assistantText: string | null;
  files: string[];
}

export function digestLatestTurn(timeline: readonly AgentTimelineItem[]): TurnDigest {
  const start = Math.max(
    0,
    timeline.findLastIndex((item) => item.type === "user_message"),
  );
  const turn = timeline.slice(start);
  const userText = turn.flatMap((item) => (item.type === "user_message" ? [item.text] : []))[0] ?? null;
  const replies = turn.flatMap((item) =>
    item.type === "assistant_message" && item.text.trim() ? [item.text] : [],
  );
  const files = new Set(turn.flatMap(editedFile));
  return { userText, assistantText: replies.at(-1) ?? null, files: [...files] };
}

function editedFile(item: AgentTimelineItem): string[] {
  if (item.type !== "tool_call") return [];
  const { detail } = item;
  return (detail.type === "edit" || detail.type === "write") && detail.filePath ? [detail.filePath] : [];
}
