import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { type MemorySettings, memorySettings, statusRpc } from "../shared/contracts";
import { AdvancedSection } from "./settings-advanced";
import { type Save, TIER_OPTIONS } from "./settings-options";
import { StatusSection } from "./settings-status";

const RERANK_OPTIONS = [
  { label: "Automatic (on for Medium and High)", value: "auto" },
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
] as const;

export function MemorySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memorySettings);
  const status = useRpc(statusRpc);
  const info = useQuery({
    queryKey: ["paseo-memory", "status"],
    queryFn: () => status({}),
    refetchInterval: 5000,
  });

  if (settings.status !== "ready") {
    const message =
      settings.status === "error" || settings.status === "invalid" ? settings.error : "Loading…";
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{message}</Text>;
  }
  const values = settings.values;
  const save: Save = (patch) => void settings.save({ ...values, ...patch }, settings.revision);

  return (
    <>
      <AgentsSection values={values} save={save} />
      <SearchSection values={values} save={save} />
      <StatusSection status={info.data ?? null} error={info.error ? String(info.error) : null} />
      <AdvancedSection values={values} status={info.data ?? null} save={save} theme={theme} />
    </>
  );
}

function AgentsSection({ values, save }: { values: MemorySettings; save: Save }) {
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSwitch
          label="Add memory to new agents"
          hint="New agents start with pinned and recent memories for this project."
          value={values.injectContext}
          onValueChange={(injectContext) => save({ injectContext })}
        />
        <SettingsSwitch
          label="Memory tools"
          hint="Lets agents search and save memories during a chat."
          value={values.injectMcp}
          onValueChange={(injectMcp) => save({ injectMcp })}
        />
        <SettingsSwitch
          label="Record session summaries"
          hint="Keeps each agent's last request and reply so later agents see recent work."
          value={values.autoCapture}
          onValueChange={(autoCapture) => save({ autoCapture })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function SearchSection({ values, save }: { values: MemorySettings; save: Save }) {
  return (
    <SettingsSection title="Search">
      <SettingsCard>
        <SettingsSelect
          label="Embedding model"
          hint="Runs on this computer and downloads once on first use."
          value={values.embeddingTier}
          options={TIER_OPTIONS}
          onValueChange={(embeddingTier) => save({ embeddingTier })}
        />
        <SettingsSelect
          label="Re-rank search results"
          hint="A second local model reorders the best matches for better precision."
          value={values.rerank}
          options={RERANK_OPTIONS}
          onValueChange={(rerank) => save({ rerank })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
