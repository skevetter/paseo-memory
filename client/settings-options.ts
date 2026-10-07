import type { PluginTheme } from "@getpaseo/plugin";
import type { MemorySettings } from "../shared/contracts";

export type Save = (patch: Partial<MemorySettings>) => void;

export interface SectionProps {
  values: MemorySettings;
  save: Save;
  theme: PluginTheme;
}

type Options<K extends keyof MemorySettings> = readonly { label: string; value: MemorySettings[K] }[];

export const STRICTNESS_OPTIONS: Options<"taskStrictness"> = [
  { label: "Low: more matches", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High: fewer, closer matches", value: "high" },
];

export const DETAIL_OPTIONS: Options<"detailLevel"> = [
  { label: "Titles", value: "titles" },
  { label: "Titles and summaries", value: "summaries" },
];

export const TRIGGER_OPTIONS: Options<"reviewTrigger"> = [
  { label: "Off", value: "off" },
  { label: "When idle", value: "idle" },
  { label: "Every few turns", value: "turns" },
];

export const DISPLAY_OPTIONS: Options<"reviewDisplay"> = [
  { label: "Collapsed to one line", value: "collapsed" },
  { label: "Shown in full", value: "full" },
  { label: "Hidden", value: "hidden" },
];

export const MERGE_OPTIONS: Options<"duplicateMerge"> = [
  { label: "Off", value: "off" },
  { label: "Suggest in the Review tab", value: "suggest" },
  { label: "Merge automatically", value: "auto" },
];

export const RERANK_OPTIONS: Options<"rerank"> = [
  { label: "Automatic (on for Medium and High)", value: "auto" },
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

type Tier = MemorySettings["embeddingTier"];

export const TIER_OPTIONS: readonly { label: string; value: Tier }[] = [
  { label: "Zero: potion-base-8M, 30 MB", value: "zero" },
  { label: "Low: bge-small-en-v1.5, 34 MB", value: "low" },
  { label: "Medium (recommended): gte-modernbert-base, 150 MB", value: "medium" },
  { label: "High: bge-large-en-v1.5, 337 MB", value: "high" },
];

export const TIER_NAMES: Record<Tier, string> = {
  zero: "Zero",
  low: "Low",
  medium: "Medium",
  high: "High",
};
