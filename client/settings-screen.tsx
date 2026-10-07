import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { memorySettings, statusRpc } from "../shared/contracts";
import { AdvancedSection } from "./settings-advanced";
import { SessionReviewSection, StartingMemorySection } from "./settings-memory";
import {
  MERGE_OPTIONS,
  RERANK_OPTIONS,
  type Save,
  type SectionProps,
  TIER_OPTIONS,
} from "./settings-options";
import { StatusSection } from "./settings-status";
import { SettingsStepper } from "./settings-stepper";

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
  const section: SectionProps = { values, save, theme };

  return (
    <>
      <StartingMemorySection {...section} />
      <SessionReviewSection {...section} />
      <SearchSection {...section} />
      <UpkeepSection {...section} />
      <StatusSection status={info.data ?? null} error={info.error ? String(info.error) : null} />
      <AdvancedSection {...section} status={info.data ?? null} />
    </>
  );
}

function SearchSection({ values, save }: SectionProps) {
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
        <SettingsSwitch
          label="Rank by use"
          hint="Memories agents open rank higher. Memories shown often and never opened rank a little lower."
          value={values.usageRanking}
          onValueChange={(usageRanking) => save({ usageRanking })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function UpkeepSection({ values, save, theme }: SectionProps) {
  return (
    <SettingsSection title="Upkeep">
      <SettingsCard>
        <SettingsSelect
          label="Duplicates"
          hint="Finds memories that say the same thing. Suggestions appear in the Review tab of the Memory panel."
          value={values.duplicateMerge}
          options={MERGE_OPTIONS}
          onValueChange={(duplicateMerge) => save({ duplicateMerge })}
        />
        <SettingsStepper
          setting="staleDays"
          label="Days until stale"
          hint="Memories nobody used or edited for this many days appear in the Review tab. Pinned memories never go stale."
          values={values}
          save={save}
          theme={theme}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
