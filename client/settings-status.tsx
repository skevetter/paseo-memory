import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { MemoryStatus } from "../shared/contracts";
import { TIER_NAMES } from "./settings-options";

type ServiceInfo = MemoryStatus["service"];
type LiveInfo = NonNullable<MemoryStatus["live"]>;

interface RowText {
  hint: string;
  error: string | null;
}

function serviceText(service: ServiceInfo): RowText {
  switch (service.state) {
    case "running":
      return { hint: "Running", error: null };
    case "starting":
      return { hint: "Starting", error: null };
    case "restarting":
      return { hint: service.detail ? `Restarting: ${service.detail}` : "Restarting", error: null };
    case "fatal":
      return { hint: "", error: service.detail ? `Stopped: ${service.detail}` : "Stopped" };
    case "stopped":
      return { hint: "Stopped", error: null };
  }
}

function embedderText({ embedder }: LiveInfo): RowText {
  const name = `${TIER_NAMES[embedder.tier]} · ${embedder.model}`;
  if (embedder.state === "error") return { hint: name, error: embedder.error ?? "The model failed to load." };
  if (embedder.pending > 0)
    return { hint: `${name} · Loading (${embedder.pending} left to index)`, error: null };
  if (embedder.state === "loading") return { hint: `${name} · Loading`, error: null };
  return { hint: `${name} · Ready`, error: null };
}

const RERANKER_STATES = { off: "Off", ready: "Ready", loading: "Loading", error: "" } as const;

function rerankerText({ reranker }: LiveInfo): RowText {
  if (reranker.state === "error") return { hint: "", error: reranker.error ?? "The model failed to load." };
  return { hint: RERANKER_STATES[reranker.state], error: null };
}

interface StatusProps {
  status: MemoryStatus | null;
  error: string | null;
}

export function StatusSection({ status, error }: StatusProps) {
  const service = status ? serviceText(status.service) : { hint: "Loading…", error: null };
  return (
    <SettingsSection title="Status">
      <SettingsCard>
        <SettingsRow label="Memory service" hint={service.hint || undefined} error={error ?? service.error} />
        {status?.live ? <LiveRows live={status.live} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function LiveRows({ live }: { live: LiveInfo }) {
  const embedder = embedderText(live);
  const reranker = rerankerText(live);
  const versions = [
    `Memory ${live.version}`,
    `Bun ${live.bunVersion}`,
    `SQLite ${live.sqliteVersion}`,
    `sqlite-vec ${live.sqliteVecVersion}`,
  ].join(" · ");
  return (
    <>
      <SettingsRow label="Versions" hint={versions} />
      <SettingsRow label="Embedding model" hint={embedder.hint} error={embedder.error} />
      <SettingsRow label="Re-ranker" hint={reranker.hint || undefined} error={reranker.error} />
      <SettingsRow
        label="Contents"
        hint={`${live.memories} memories · ${live.projects} projects · ${live.sessions} sessions`}
      />
      <SettingsRow label="Database" hint={live.dbPath} />
    </>
  );
}
