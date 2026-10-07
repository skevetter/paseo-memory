import { describe, expect, test } from "bun:test";
import {
  REVIEW_ITEM_KIND,
  REVIEW_ITEM_VERSION,
  transformAssistantMessage,
  transformUserMessage,
} from "../client/review-timeline";
import { reviewPrompt } from "../shared/review";

const reply = (display: string) =>
  `[paseo-memory:review-reply v1 ${display}]\nSummary: Fixed the login bug.\nSaved: #14\nUpdated: #9`;

describe("review timeline", () => {
  test("collapsed hides the prompt and replaces the reply with one row", () => {
    expect(transformUserMessage(reviewPrompt({ cap: 3, display: "collapsed" }))).toEqual({ items: [] });
    expect(transformAssistantMessage(reply("collapsed"), "complete")).toEqual({
      items: [
        {
          type: "plugin",
          kind: REVIEW_ITEM_KIND,
          version: REVIEW_ITEM_VERSION,
          data: {
            headline: "Memory review: saved #14, updated #9",
            summary: "Fixed the login bug.",
            pending: false,
          },
        },
      ],
    });
  });

  test("collapsed reply is pending while streaming", () => {
    const result = transformAssistantMessage(reply("collapsed"), "streaming");
    expect(result?.items[0]?.data).toMatchObject({ pending: true });
  });

  test("hidden removes both", () => {
    expect(transformUserMessage(reviewPrompt({ cap: 3, display: "hidden" }))).toEqual({ items: [] });
    expect(transformAssistantMessage(reply("hidden"), "complete")).toEqual({ items: [] });
  });

  test("full leaves both", () => {
    expect(transformUserMessage(reviewPrompt({ cap: 3, display: "full" }))).toBeUndefined();
    expect(transformAssistantMessage(reply("full"), "complete")).toBeUndefined();
  });

  test("a streaming partial marker is hidden", () => {
    expect(transformAssistantMessage("[paseo-memory:rev", "streaming")).toEqual({ items: [] });
  });

  test("normal messages are untouched", () => {
    expect(transformUserMessage("Please fix the login bug.")).toBeUndefined();
    expect(transformAssistantMessage("Done. The bug is fixed.", "complete")).toBeUndefined();
    expect(transformAssistantMessage("Working on it", "streaming")).toBeUndefined();
  });
});
