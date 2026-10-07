import type { MemorySettings } from "../shared/contracts";

export type Save = (patch: Partial<MemorySettings>) => void;

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
