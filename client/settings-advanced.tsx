import type { PluginTheme } from "@getpaseo/plugin";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import type { MemorySettings, MemoryStatus } from "../shared/contracts";
import type { Save } from "./settings-options";

type PathKey = keyof MemoryStatus["paths"];
type PathSetting = "bunPath" | "sqlitePath" | "servicePath";
type Drafts = Pick<MemorySettings, PathSetting>;

const PATHS: readonly { key: PathKey; setting: PathSetting; label: string }[] = [
  { key: "bun", setting: "bunPath", label: "Bun" },
  { key: "sqlite", setting: "sqlitePath", label: "SQLite library" },
  { key: "service", setting: "servicePath", label: "Service directory" },
];

// Bun and the service directory resolve before the service starts; SQLite resolves inside it.
function resolvedText(key: PathKey, status: MemoryStatus | null): string {
  const waiting = "Shown when the service is running";
  if (!status) return waiting;
  const { value, source } = status.paths[key];
  if (value) return `Using ${value} (${source})`;
  return key === "sqlite" && status.service.state !== "running" ? waiting : "Not found";
}

interface AdvancedProps {
  values: MemorySettings;
  status: MemoryStatus | null;
  save: Save;
  theme: PluginTheme;
}

export function AdvancedSection({ values, status, save, theme }: AdvancedProps) {
  const [open, setOpen] = useState(false);
  // Drafts live here so hiding the section keeps unapplied edits.
  const [draft, setDraft] = useState<Drafts>({
    bunPath: values.bunPath,
    sqlitePath: values.sqlitePath,
    servicePath: values.servicePath,
  });
  const toggle = (
    <Pressable
      onPress={() => setOpen(!open)}
      accessibilityRole="button"
      accessibilityLabel={open ? "Hide advanced settings" : "Show advanced settings"}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{open ? "Hide" : "Show"}</Text>
    </Pressable>
  );
  return (
    <SettingsSection title="Advanced" trailing={toggle}>
      {open ? (
        <PathOverrides values={values} status={status} save={save} draft={draft} setDraft={setDraft} />
      ) : null}
    </SettingsSection>
  );
}

interface OverridesProps {
  values: MemorySettings;
  status: MemoryStatus | null;
  save: Save;
  draft: Drafts;
  setDraft: (update: (draft: Drafts) => Drafts) => void;
}

// Overrides are drafts until applied, because each change restarts the service.
function PathOverrides({ values, status, save, draft, setDraft }: OverridesProps) {
  const changed = PATHS.some(({ setting }) => draft[setting].trim() !== values[setting]);
  return (
    <SettingsCard>
      {PATHS.flatMap(({ key, setting, label }) => [
        <SettingsRow key={`${key}-value`} label={label} hint={resolvedText(key, status)} />,
        <SettingsInput
          key={`${key}-override`}
          label="Override path"
          hint="Leave blank to detect automatically."
          initialValue={draft[setting]}
          onChangeText={(text) => setDraft((d) => ({ ...d, [setting]: text }))}
        />,
      ])}
      <SettingsAction
        label="Apply overrides"
        hint="Restarts the memory service."
        actionLabel="Apply"
        disabled={!changed}
        onPress={() =>
          save({
            bunPath: draft.bunPath.trim(),
            sqlitePath: draft.sqlitePath.trim(),
            servicePath: draft.servicePath.trim(),
          })
        }
      />
    </SettingsCard>
  );
}
