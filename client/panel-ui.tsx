import { Pressable, Text } from "react-native";
import type { Styles } from "./panel-styles";

interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  s: Styles;
}

export function Chip({ label, active, onPress, accessibilityLabel, disabled, s }: ChipProps) {
  return (
    <Pressable
      style={s.chip(active)}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={s.chipText(active)}>{label}</Text>
    </Pressable>
  );
}

interface LinkProps {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  danger?: boolean;
  disabled?: boolean;
  s: Styles;
}

export function Link({ label, onPress, accessibilityLabel, danger, disabled, s }: LinkProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={danger ? s.danger : s.action}>{label}</Text>
    </Pressable>
  );
}

interface QueryStateProps {
  loading: boolean;
  error: unknown;
  empty: boolean;
  emptyText: string;
  s: Styles;
}

export function QueryState({ loading, error, empty, emptyText, s }: QueryStateProps) {
  if (loading) return <Text style={s.muted}>Loading…</Text>;
  if (error) return <Text style={s.danger}>{String(error)}</Text>;
  if (empty) return <Text style={s.muted}>{emptyText}</Text>;
  return null;
}
