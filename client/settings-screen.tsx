import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { memorySettings, statusRpc } from "../shared/contracts";

export function MemorySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memorySettings);
  const status = useRpc(statusRpc);
  const info = useQuery({ queryKey: ["paseo-memory-status"], queryFn: () => status({}), refetchInterval: 10_000 });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };

  if (settings.status !== "ready") {
    return <Text style={muted}>{settings.status === "error" || settings.status === "invalid" ? settings.error : "Loading…"}</Text>;
  }
  const values = settings.values;
  const set = (patch: Partial<typeof values>) => void settings.save({ ...values, ...patch }, settings.revision);

  return (
    <>
      <SettingsSection title="Agents">
        <SettingsCard>
          <SettingsSwitch
            label="Inject memory context"
            hint="Adds pinned and recent project and global memory to each new agent's system prompt."
            value={values.injectContext}
            onValueChange={(injectContext) => set({ injectContext })}
          />
          <SettingsSwitch
            label="Memory tools (MCP)"
            hint="Gives agents memory_search, memory_save and related tools."
            value={values.injectMcp}
            onValueChange={(injectMcp) => set({ injectMcp })}
          />
          <SettingsSwitch
            label="Record session digests"
            hint="Keeps the last prompt and reply of each agent so new agents see recent work. Redacted, no tool output."
            value={values.autoCapture}
            onValueChange={(autoCapture) => set({ autoCapture })}
          />
          <SettingsSelect
            label="Semantic search"
            hint="model2vec downloads a 30 MB model once. Off uses keyword search only."
            value={values.embeddings}
            options={[
              { label: "model2vec (local)", value: "model2vec" },
              { label: "Off", value: "off" },
            ]}
            onValueChange={(embeddings) => set({ embeddings })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Status">
        <SettingsCard>
          <SettingsRow label="Database" hint={info.data?.dbPath ?? "…"} />
          <SettingsRow
            label="Contents"
            hint={info.data ? `${info.data.memories} memories · ${info.data.projects} projects · ${info.data.sessions} sessions` : "…"}
          />
          <SettingsRow label="Embeddings" hint={info.data ? `${info.data.embeddings} · index ${info.data.vectorIndex}` : "…"} />
          <SettingsRow label="MCP" hint={info.data?.mcp ?? "…"} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
