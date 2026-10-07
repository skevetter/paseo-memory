import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import { z } from "zod";
import {
  isPartialReviewReply,
  isReviewReply,
  parseReviewReply,
  reviewHeadline,
  reviewPromptDisplay,
} from "../shared/review";

export const REVIEW_ITEM_KIND = "review";
export const REVIEW_ITEM_VERSION = 1;

export const ReviewItemSchema = z.object({
  headline: z.string(),
  summary: z.string().nullable(),
  pending: z.boolean(),
});

export type ReviewItem = z.infer<typeof ReviewItemSchema>;

type Phase = "streaming" | "complete";

export function transformUserMessage(text: string): PluginTimelineTransformResult | undefined {
  const display = reviewPromptDisplay(text);
  return display === "collapsed" || display === "hidden" ? { items: [] } : undefined;
}

export function transformAssistantMessage(
  text: string,
  phase: Phase,
): PluginTimelineTransformResult | undefined {
  if (!isReviewReply(text)) {
    return phase === "streaming" && isPartialReviewReply(text) ? { items: [] } : undefined;
  }
  const reply = parseReviewReply(text);
  if (reply.display === "full") return undefined;
  if (reply.display === "hidden") return { items: [] };
  const data: ReviewItem = {
    headline: reviewHeadline(reply),
    summary: reply.summary,
    pending: phase === "streaming",
  };
  return { items: [{ type: "plugin", kind: REVIEW_ITEM_KIND, version: REVIEW_ITEM_VERSION, data }] };
}
