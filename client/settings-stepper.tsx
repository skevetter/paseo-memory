import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { type MemorySettings, RANGES } from "../shared/contracts";
import type { SectionProps } from "./settings-options";

export type StepperKey = keyof typeof RANGES & keyof MemorySettings;

export interface StepperField {
  setting: StepperKey;
  label: string;
  hint: string;
}

type StepperProps = StepperField & SectionProps;

export function SettingsStepper({ setting, label, hint, values, save, theme }: StepperProps) {
  const { min, max, step } = RANGES[setting];
  const value = values[setting];
  const change = (delta: number) => {
    const patch: Partial<MemorySettings> = {};
    patch[setting] = Math.min(max, Math.max(min, value + delta * step));
    save(patch);
  };
  return (
    <SettingsRow label={label} hint={hint}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <StepButton
          symbol="−"
          label={`Decrease ${label}`}
          disabled={value <= min}
          onPress={() => change(-1)}
          theme={theme}
        />
        <Text
          style={{ color: theme.colors.foreground, fontSize: 13, minWidth: 40, textAlign: "center" }}
          accessibilityLabel={`${label}: ${value}`}
        >
          {value}
        </Text>
        <StepButton
          symbol="+"
          label={`Increase ${label}`}
          disabled={value >= max}
          onPress={() => change(1)}
          theme={theme}
        />
      </View>
    </SettingsRow>
  );
}

interface StepButtonProps {
  symbol: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
  theme: PluginTheme;
}

function StepButton({ symbol, label, disabled, onPress, theme }: StepButtonProps) {
  const { colors } = theme;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: colors.foreground, fontSize: 16 }}>{symbol}</Text>
    </Pressable>
  );
}
