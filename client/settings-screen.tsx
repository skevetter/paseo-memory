import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { type MemorySettings, type MemoryStatus, memorySettings, statusRpc } from "../shared/contracts";

type Save = (patch: Partial<MemorySettings>) => void;

const TIER_OPTIONS = [
  { label: "Medium: gte-modernbert-base, 768d, 150 MB (default)", value: "medium" },
  { label: "High: bge-large-en-v1.5, 1024d, 340 MB", value: "high" },
  { label: "Low: bge-small-en-v1.5, 384d, 34 MB", value: "low" },
  { label: "Zero: model2vec potion-base-8M, 256d, 30 MB, no ONNX", value: "zero" },
] as const;

export function MemorySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memorySettings);
  const status = useRpc(statusRpc);
  const info = useQuery({
    queryKey: ["paseo-memory-status"],
    queryFn: () => status({}),
    refetchInterval: 5000,
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };

  if (settings.status !== "ready") {
    const message =
      settings.status === "error" || settings.status === "invalid" ? settings.error : "Loading…";
    return <Text style={muted}>{message}</Text>;
  }
  const values = settings.values;
  const save: Save = (patch) => void settings.save({ ...values, ...patch }, settings.revision);

  return (
    <>
      <AgentsSection values={values} save={save} />
      <StatusSection status={info.data ?? null} error={info.error ? String(info.error) : null} />
      <PathsSection values={values} save={save} />
    </>
  );
}

function AgentsSection({ values, save }: { values: MemorySettings; save: Save }) {
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSwitch
          label="Inject memory context"
          hint="Adds pinned and recent project and global memory to each new agent's system prompt."
          value={values.injectContext}
          onValueChange={(injectContext) => save({ injectContext })}
        />
        <SettingsSwitch
          label="Memory tools (MCP)"
          hint="Gives agents memory_search, memory_save and related tools."
          value={values.injectMcp}
          onValueChange={(injectMcp) => save({ injectMcp })}
        />
        <SettingsSwitch
          label="Record session digests"
          hint="Keeps the last prompt and reply of each agent so new agents see recent work. Redacted, no tool output."
          value={values.autoCapture}
          onValueChange={(autoCapture) => save({ autoCapture })}
        />
        <SettingsSelect
          label="Embedding model"
          hint="Runs locally in the memory service. The model downloads once on first use; keyword search works while it loads. Changing it re-embeds memories in the background."
          value={values.embeddingTier}
          options={TIER_OPTIONS}
          onValueChange={(embeddingTier) => save({ embeddingTier })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

type ServiceInfo = MemoryStatus["service"];
type LiveInfo = NonNullable<MemoryStatus["live"]>;

function StatusSection({ status, error }: { status: MemoryStatus | null; error: string | null }) {
  return (
    <SettingsSection title="Status">
      <SettingsCard>
        {status ? (
          <ServiceRows service={status.service} error={error} />
        ) : (
          <SettingsRow label="Memory service" hint="…" error={error} />
        )}
        {status?.live ? <LiveRows live={status.live} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

// A missing bun or sqlite-vec shows as the service's fatal detail.
function ServiceRows({ service, error }: { service: ServiceInfo; error: string | null }) {
  const failing = service.state === "fatal" || service.state === "restarting";
  const entry = service.servicePath
    ? `${service.servicePath} (${service.servicePathSource})`
    : "not resolved";
  return (
    <>
      <SettingsRow
        label="Memory service"
        hint={service.pid ? `${service.state} · pid ${service.pid}` : service.state}
        error={error ?? (failing ? service.detail : null)}
      />
      <SettingsRow label="Bun" hint={bunHint(service)} error={service.bunPath ? null : "bun not found"} />
      <SettingsRow label="Service entry" hint={entry} />
    </>
  );
}

function LiveRows({ live }: { live: LiveInfo }) {
  const { embedder } = live;
  const pending = embedder.pending ? ` · ${embedder.pending} to embed` : "";
  return (
    <>
      <SettingsRow
        label="SQLite"
        hint={[live.sqliteVersion, live.sqliteLibrary].filter(Boolean).join(" · ")}
      />
      <SettingsRow label="sqlite-vec" hint={live.sqliteVecVersion} />
      <SettingsRow
        label="Embeddings"
        hint={`${embedder.tier} · ${embedder.model} (${embedder.dims}d) · ${embedder.state}${pending}`}
        error={embedder.error}
      />
      <SettingsRow label="Database" hint={live.dbPath} />
      <SettingsRow
        label="Contents"
        hint={`${live.memories} memories · ${live.projects} projects · ${live.sessions} sessions`}
      />
      <SettingsRow label="MCP" hint={live.mcpUrl} />
    </>
  );
}

function bunHint(service: ServiceInfo): string {
  if (!service.bunPath) return "not found";
  return service.bunVersion ? `${service.bunPath} · ${service.bunVersion}` : service.bunPath;
}

// Paths are drafts until applied, because each change restarts the service.
function PathsSection({ values, save }: { values: MemorySettings; save: Save }) {
  const [draft, setDraft] = useState({
    bunPath: values.bunPath,
    sqlitePath: values.sqlitePath,
    servicePath: values.servicePath,
  });
  const changed =
    draft.bunPath !== values.bunPath ||
    draft.sqlitePath !== values.sqlitePath ||
    draft.servicePath !== values.servicePath;
  return (
    <SettingsSection title="Service paths">
      <SettingsCard>
        <SettingsInput
          label="bun"
          hint="Empty: PATH, then /opt/homebrew/bin/bun, then ~/.bun/bin/bun."
          initialValue={values.bunPath}
          placeholder="auto"
          onChangeText={(bunPath) => setDraft((d) => ({ ...d, bunPath }))}
        />
        <SettingsInput
          label="SQLite library (macOS)"
          hint="Empty: Homebrew libsqlite3.dylib. Apple's system SQLite cannot load sqlite-vec."
          initialValue={values.sqlitePath}
          placeholder="auto"
          onChangeText={(sqlitePath) => setDraft((d) => ({ ...d, sqlitePath }))}
        />
        <SettingsInput
          label="Service directory"
          hint="Empty: this plugin's directory from Paseo's config.json."
          initialValue={values.servicePath}
          placeholder="auto"
          onChangeText={(servicePath) => setDraft((d) => ({ ...d, servicePath }))}
        />
        <SettingsAction
          label="Apply paths"
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
    </SettingsSection>
  );
}
