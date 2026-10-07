import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ReviewItem } from "./review-timeline";

function summaryText({ summary, pending }: ReviewItem): string {
  if (pending) return "Working on the summary";
  return summary ?? "No summary.";
}

export function ReviewRow({ item, theme }: PluginTimelineItemProps<ReviewItem>) {
  const [open, setOpen] = useState(false);
  const { colors } = theme;
  return (
    <View style={{ paddingVertical: 4, gap: 4 }}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? "Hide the memory review summary" : "Show the memory review summary"}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {open ? "▾" : "▸"} {item.data.headline}
        </Text>
      </Pressable>
      {open ? <Text style={{ color: colors.foreground, fontSize: 13 }}>{summaryText(item.data)}</Text> : null}
    </View>
  );
}
