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
import type { Save, SectionProps } from "./settings-options";
import { SettingsStepper } from "./settings-stepper";

type PathKey = keyof MemoryStatus["paths"];
type PathSetting = "bunPath" | "sqlitePath" | "servicePath";
type Drafts = Pick<MemorySettings, PathSetting>;

const PATHS: readonly { key: PathKey; setting: PathSetting; label: string }[] = [
  { key: "bun", setting: "bunPath", label: "Bun" },
  { key: "sqlite", setting: "sqlitePath", label: "SQLite library" },
  { key: "service", setting: "servicePath", label: "Service directory" },
];

const PORT_RANGE = { min: 1024, max: 65535 };

function resolvedText(key: PathKey, status: MemoryStatus | null): string {
  const waiting = "Shown when the service is running";
  if (!status) return waiting;
  const { value, source } = status.paths[key];
  if (value) return `Using ${value} (${source})`;
  const resolvesInsideService = key === "sqlite";
  return resolvesInsideService && status.service.state !== "running" ? waiting : "Not found";
}

interface AdvancedProps extends SectionProps {
  status: MemoryStatus | null;
}

export function AdvancedSection({ values, status, save, theme }: AdvancedProps) {
  const [open, setOpen] = useState(false);
  // Drafts live here so hiding the section keeps unapplied edits.
  const [draft, setDraft] = useState<Drafts>({
    bunPath: values.bunPath,
    sqlitePath: values.sqlitePath,
    servicePath: values.servicePath,
  });
  const [port, setPort] = useState(String(values.mcpPort));
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
        <>
          <ServiceOptions section={{ values, save, theme }} port={port} setPort={setPort} />
          <PathOverrides values={values} status={status} save={save} draft={draft} setDraft={setDraft} />
        </>
      ) : null}
    </SettingsSection>
  );
}

interface ServiceOptionsProps {
  section: SectionProps;
  port: string;
  setPort: (port: string) => void;
}

function parsePort(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= PORT_RANGE.min && value <= PORT_RANGE.max ? value : null;
}

// The port is a draft until applied, because each change restarts the service.
function ServiceOptions({ section, port, setPort }: ServiceOptionsProps) {
  const parsed = parsePort(port);
  return (
    <SettingsCard>
      <SettingsStepper
        setting="sessionRetentionDays"
        label="Keep session history"
        hint="Days to keep session summaries and agent activity. Changing this restarts the memory service."
        {...section}
      />
      <SettingsInput
        label="Memory tools port"
        hint="The local port agents use to reach the memory tools."
        error={parsed === null ? `Use a whole number from ${PORT_RANGE.min} to ${PORT_RANGE.max}.` : null}
        initialValue={port}
        onChangeText={setPort}
      />
      <SettingsAction
        label="Apply port"
        hint="Restarts the memory service."
        actionLabel="Apply"
        disabled={parsed === null || parsed === section.values.mcpPort}
        onPress={() => {
          if (parsed !== null) section.save({ mcpPort: parsed });
        }}
      />
    </SettingsCard>
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
