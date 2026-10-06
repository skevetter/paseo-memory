import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  type MemoryItem,
  deleteMemoryRpc,
  saveMemoryRpc,
  searchMemoriesRpc,
  updateMemoryRpc,
} from "../shared/contracts";

type Scope = "all" | "project" | "global";

export function MemoryPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const projectId = useWorkspace(workspaceId, (w) => w.projectId);
  const projectName = useWorkspace(workspaceId, (w) => w.projectDisplayName);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftGlobal, setDraftGlobal] = useState(false);
  const search = useRpc(searchMemoriesRpc);
  const save = useRpc(saveMemoryRpc);
  const update = useRpc(updateMemoryRpc);
  const remove = useRpc(deleteMemoryRpc);
  const queryClient = useQueryClient();
  const key = ["paseo-memory", projectId, scope, query];

  const results = useQuery({
    queryKey: key,
    queryFn: () => search({ query, paseoProjectId: projectId ?? null, scope, limit: 30 }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["paseo-memory"] });
  const saveMutation = useMutation({
    mutationFn: () =>
      save({
        title: draftTitle.trim(),
        content: draftContent.trim(),
        type: "note",
        scope: draftGlobal ? "global" : "project",
        paseoProjectId: projectId ?? null,
        pinned: false,
      }),
    onSuccess: () => {
      setDraftTitle("");
      setDraftContent("");
      void refresh();
    },
  });
  const pinMutation = useMutation({
    mutationFn: (item: MemoryItem) => update({ id: Number(item.id), pinned: !item.pinned }),
    onSuccess: () => void refresh(),
  });
  const deleteMutation = useMutation({
    mutationFn: (item: MemoryItem) => remove({ id: Number(item.id) }),
    onSuccess: () => void refresh(),
  });

  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      pad: { padding: 12, gap: 8 },
      text: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      input: {
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        fontSize: 13,
      },
      row: { flexDirection: "row" as const, gap: 6, alignItems: "center" as const, flexWrap: "wrap" as const },
      chip: (active: boolean) => ({
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
      }),
      chipText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foreground,
        fontSize: 12,
      }),
      card: {
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 4,
        backgroundColor: theme.colors.surface1,
      },
      action: { color: theme.colors.accent, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );

  const items = results.data?.items ?? [];
  return (
    <ScrollView style={s.root} contentContainerStyle={s.pad}>
      <Text style={s.muted}>
        {projectName ? `Project: ${projectName} (shared across worktrees)` : "No project"} · global memory applies everywhere
      </Text>
      <TextInput
        style={s.input}
        placeholder="Search memory"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={query}
        onChangeText={setQuery}
        accessibilityLabel="Search memory"
      />
      <View style={s.row}>
        {(["all", "project", "global"] as const).map((value) => (
          <Pressable
            key={value}
            style={s.chip(scope === value)}
            onPress={() => setScope(value)}
            accessibilityRole="button"
            accessibilityLabel={`Show ${value} memory`}
          >
            <Text style={s.chipText(scope === value)}>{value}</Text>
          </Pressable>
        ))}
      </View>
      {results.isLoading ? <Text style={s.muted}>Loading…</Text> : null}
      {results.error ? <Text style={s.danger}>{String(results.error)}</Text> : null}
      {!results.isLoading && items.length === 0 ? <Text style={s.muted}>No memories.</Text> : null}
      {items.map((item) => (
        <View key={`${item.kind}:${item.id}`} style={s.card}>
          <Text style={s.text}>
            {item.pinned ? "📌 " : ""}
            {item.title}
          </Text>
          <Text style={s.muted}>
            {item.kind === "session" ? "session" : `#${item.id} · ${item.type}`} · {item.scope === "global" ? "global" : (item.projectName ?? "project")} ·{" "}
            {item.updatedAt.slice(0, 10)}
          </Text>
          <Text style={s.muted} numberOfLines={4}>
            {item.preview}
          </Text>
          {item.kind === "memory" ? (
            <View style={s.row}>
              <Pressable onPress={() => pinMutation.mutate(item)} accessibilityRole="button" accessibilityLabel="Toggle pin">
                <Text style={s.action}>{item.pinned ? "Unpin" : "Pin"}</Text>
              </Pressable>
              <Pressable onPress={() => deleteMutation.mutate(item)} accessibilityRole="button" accessibilityLabel="Delete memory">
                <Text style={s.danger}>Delete</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
      <View style={[s.card, { marginTop: 8 }]}>
        <Text style={s.text}>Add a memory</Text>
        <TextInput
          style={s.input}
          placeholder="Title"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={draftTitle}
          onChangeText={setDraftTitle}
          accessibilityLabel="Memory title"
        />
        <TextInput
          style={[s.input, { minHeight: 64 }]}
          placeholder="What / Why / Where / Learned"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={draftContent}
          onChangeText={setDraftContent}
          multiline
          accessibilityLabel="Memory content"
        />
        <View style={s.row}>
          <Pressable style={s.chip(!draftGlobal)} onPress={() => setDraftGlobal(false)} accessibilityRole="button" accessibilityLabel="Project scope">
            <Text style={s.chipText(!draftGlobal)}>project</Text>
          </Pressable>
          <Pressable style={s.chip(draftGlobal)} onPress={() => setDraftGlobal(true)} accessibilityRole="button" accessibilityLabel="Global scope">
            <Text style={s.chipText(draftGlobal)}>global</Text>
          </Pressable>
          <Pressable
            style={s.chip(true)}
            disabled={!draftTitle.trim() || !draftContent.trim() || saveMutation.isPending}
            onPress={() => saveMutation.mutate()}
            accessibilityRole="button"
            accessibilityLabel="Save memory"
          >
            <Text style={s.chipText(true)}>{saveMutation.isPending ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>
        {saveMutation.data ? <Text style={s.muted}>{saveMutation.data.message}</Text> : null}
      </View>
    </ScrollView>
  );
}
