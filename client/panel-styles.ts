import type { PluginTheme } from "@getpaseo/plugin";
import { useQueryClient } from "@tanstack/react-query";
import type { TextStyle, ViewStyle } from "react-native";

export const QUERY_ROOT = "paseo-memory";

export interface Styles {
  root: ViewStyle;
  pad: ViewStyle;
  text: TextStyle;
  title: TextStyle;
  heading: TextStyle;
  muted: TextStyle;
  input: TextStyle;
  row: ViewStyle;
  chip(active: boolean): ViewStyle;
  chipText(active: boolean): TextStyle;
  card: ViewStyle;
  section: ViewStyle;
  action: TextStyle;
  danger: TextStyle;
  placeholder: string;
}

export function panelStyles(theme: PluginTheme): Styles {
  const { colors } = theme;
  return {
    root: { flex: 1, backgroundColor: colors.surface0 },
    pad: { padding: 12, gap: 8 },
    text: { color: colors.foreground, fontSize: 13 },
    title: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
    heading: { color: colors.foreground, fontSize: 13, fontWeight: "600", marginTop: 8 },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    input: {
      color: colors.foreground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontSize: 13,
    },
    row: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
    chip: (active: boolean) => ({
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: active ? colors.accent : colors.surface2,
    }),
    chipText: (active: boolean) => ({
      color: active ? colors.accentForeground : colors.foreground,
      fontSize: 12,
    }),
    card: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      gap: 4,
      backgroundColor: colors.surface1,
    },
    section: { gap: 6 },
    action: { color: colors.accent, fontSize: 12 },
    danger: { color: colors.statusDanger, fontSize: 12 },
    placeholder: colors.foregroundMuted,
  };
}

export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
}

// Timestamps arrive as ISO-like strings; slicing keeps them stable across platforms.
export function formatDate(at: string): string {
  return at.slice(0, 10);
}

export function formatDateTime(at: string): string {
  return at.slice(0, 16).replace("T", " ");
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
