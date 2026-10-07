import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, type TextStyle, View, type ViewStyle } from "react-native";
import {
  deleteMemoryRpc,
  type MemoryItem,
  saveMemoryRpc,
  searchMemoriesRpc,
  updateMemoryRpc,
} from "../shared/contracts";

type Scope = "all" | "project" | "global";

interface Styles {
  root: ViewStyle;
  pad: ViewStyle;
  text: TextStyle;
  muted: TextStyle;
  input: TextStyle;
  row: ViewStyle;
  chip(active: boolean): ViewStyle;
  chipText(active: boolean): TextStyle;
  card: ViewStyle;
  action: TextStyle;
  danger: TextStyle;
  placeholder: string;
}

function panelStyles(theme: PluginTheme): Styles {
  return {
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
    placeholder: theme.colors.foregroundMuted,
  };
}

export function MemoryPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const projectId = useWorkspace(workspaceId, (w) => w.projectId) ?? null;
  const projectName = useWorkspace(workspaceId, (w) => w.projectDisplayName);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const search = useRpc(searchMemoriesRpc);
  const s = useMemo(() => panelStyles(theme), [theme]);
  const results = useQuery({
    queryKey: ["paseo-memory", projectId, scope, query],
    queryFn: () => search({ query, paseoProjectId: projectId, scope, limit: 30 }),
  });
  const items = results.data?.items ?? [];

  return (
    <ScrollView style={s.root} contentContainerStyle={s.pad}>
      <Text style={s.muted}>
        {projectName ? `Project: ${projectName} (shared across worktrees)` : "No project"} · global memory
        applies everywhere
      </Text>
      <TextInput
        style={s.input}
        placeholder="Search memory"
        placeholderTextColor={s.placeholder}
        value={query}
        onChangeText={setQuery}
        accessibilityLabel="Search memory"
      />
      <ScopeChips scope={scope} onChange={setScope} s={s} />
      {results.isLoading ? <Text style={s.muted}>Loading…</Text> : null}
      {results.error ? <Text style={s.danger}>{String(results.error)}</Text> : null}
      {!results.isLoading && items.length === 0 ? <Text style={s.muted}>No memories.</Text> : null}
      {items.map((item) => (
        <MemoryCard key={`${item.kind}:${item.id}`} item={item} s={s} />
      ))}
      <AddMemoryForm projectId={projectId} s={s} />
    </ScrollView>
  );
}

function ScopeChips({ scope, onChange, s }: { scope: Scope; onChange: (scope: Scope) => void; s: Styles }) {
  return (
    <View style={s.row}>
      {(["all", "project", "global"] as const).map((value) => (
        <Pressable
          key={value}
          style={s.chip(scope === value)}
          onPress={() => onChange(value)}
          accessibilityRole="button"
          accessibilityLabel={`Show ${value} memory`}
        >
          <Text style={s.chipText(scope === value)}>{value}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["paseo-memory"] });
}

function MemoryCard({ item, s }: { item: MemoryItem; s: Styles }) {
  const update = useRpc(updateMemoryRpc);
  const remove = useRpc(deleteMemoryRpc);
  const refresh = useRefresh();
  const pin = useMutation({
    mutationFn: () => update({ id: Number(item.id), pinned: !item.pinned }),
    onSuccess: () => void refresh(),
  });
  const del = useMutation({
    mutationFn: () => remove({ id: Number(item.id) }),
    onSuccess: () => void refresh(),
  });
  const label = item.kind === "session" ? "session" : `#${item.id} · ${item.type}`;
  const where = item.scope === "global" ? "global" : (item.projectName ?? "project");
  return (
    <View style={s.card}>
      <Text style={s.text}>
        {item.pinned ? "📌 " : ""}
        {item.title}
      </Text>
      <Text style={s.muted}>
        {label} · {where} · {item.updatedAt.slice(0, 10)}
      </Text>
      <Text style={s.muted} numberOfLines={4}>
        {item.preview}
      </Text>
      {item.kind === "memory" ? (
        <View style={s.row}>
          <Pressable onPress={() => pin.mutate()} accessibilityRole="button" accessibilityLabel="Toggle pin">
            <Text style={s.action}>{item.pinned ? "Unpin" : "Pin"}</Text>
          </Pressable>
          <Pressable
            onPress={() => del.mutate()}
            accessibilityRole="button"
            accessibilityLabel="Delete memory"
          >
            <Text style={s.danger}>Delete</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function AddMemoryForm({ projectId, s }: { projectId: string | null; s: Styles }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [global, setGlobal] = useState(false);
  const save = useRpc(saveMemoryRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: () =>
      save({
        title: title.trim(),
        content: content.trim(),
        type: "note",
        scope: global ? "global" : "project",
        paseoProjectId: projectId,
        pinned: false,
      }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      void refresh();
    },
  });
  const disabled = !title.trim() || !content.trim() || mutation.isPending;
  return (
    <View style={[s.card, { marginTop: 8 }]}>
      <Text style={s.text}>Add a memory</Text>
      <TextInput
        style={s.input}
        placeholder="Title"
        placeholderTextColor={s.placeholder}
        value={title}
        onChangeText={setTitle}
        accessibilityLabel="Memory title"
      />
      <TextInput
        style={[s.input, { minHeight: 64 }]}
        placeholder="What / Why / Where / Learned"
        placeholderTextColor={s.placeholder}
        value={content}
        onChangeText={setContent}
        multiline
        accessibilityLabel="Memory content"
      />
      <View style={s.row}>
        <Pressable
          style={s.chip(!global)}
          onPress={() => setGlobal(false)}
          accessibilityRole="button"
          accessibilityLabel="Project scope"
        >
          <Text style={s.chipText(!global)}>project</Text>
        </Pressable>
        <Pressable
          style={s.chip(global)}
          onPress={() => setGlobal(true)}
          accessibilityRole="button"
          accessibilityLabel="Global scope"
        >
          <Text style={s.chipText(global)}>global</Text>
        </Pressable>
        <Pressable
          style={s.chip(true)}
          disabled={disabled}
          onPress={() => mutation.mutate()}
          accessibilityRole="button"
          accessibilityLabel="Save memory"
        >
          <Text style={s.chipText(true)}>{mutation.isPending ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>
      {mutation.data ? <Text style={s.muted}>{mutation.data.message}</Text> : null}
    </View>
  );
}
