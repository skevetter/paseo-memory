import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { MAX_CONTENT_CHARS, type MemoryItem, saveMemoryRpc, searchMemoriesRpc } from "../shared/contracts";
import { formatDate, plural, QUERY_ROOT, type Styles, useRefresh } from "./panel-styles";
import { Chip, QueryState } from "./panel-ui";

type Scope = "all" | "project" | "global";

const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "project", label: "Project" },
  { value: "global", label: "Global" },
];

const SHOW_REMAINING_WITHIN = 500;

interface MemoriesTabProps {
  projectId: string | null;
  projectName: string | null;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

export function MemoriesTab({ projectId, projectName, onOpenMemory, s }: MemoriesTabProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [stale, setStale] = useState(false);
  const search = useRpc(searchMemoriesRpc);
  const results = useQuery({
    queryKey: [QUERY_ROOT, "search", projectId, scope, stale, query],
    queryFn: () => search({ query, paseoProjectId: projectId, scope, stale, limit: 30 }),
  });
  const items = results.data?.items ?? [];
  return (
    <>
      <Text style={s.muted}>
        {projectName ? `Project memories are shared by every worktree of ${projectName}.` : "No project."}{" "}
        Global memories apply everywhere.
      </Text>
      <TextInput
        style={s.input}
        placeholder="Search memory"
        placeholderTextColor={s.placeholder}
        value={query}
        onChangeText={setQuery}
        accessibilityLabel="Search memory"
      />
      <View style={s.row}>
        {SCOPES.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            active={scope === value}
            onPress={() => setScope(value)}
            accessibilityLabel={`Show ${label.toLowerCase()} memories`}
            s={s}
          />
        ))}
        <Chip
          label="Stale"
          active={stale}
          onPress={() => setStale(!stale)}
          accessibilityLabel="Show memories nobody used or edited recently"
          s={s}
        />
      </View>
      <QueryState
        loading={results.isLoading}
        error={results.error}
        empty={items.length === 0}
        emptyText={stale ? "No stale memories." : "No memories."}
        s={s}
      />
      {items.map((item) => (
        <MemoryCard key={`${item.kind}:${item.id}`} item={item} onOpenMemory={onOpenMemory} s={s} />
      ))}
      <AddMemoryForm projectId={projectId} s={s} />
    </>
  );
}

function cardMeta(item: MemoryItem): string {
  const where = item.scope === "global" ? "global" : (item.projectName ?? "project");
  const label = item.kind === "session" ? "session" : `#${item.id} · ${item.type}`;
  const parts = [label, where, formatDate(item.updatedAt)];
  if (item.pinned) parts.push("pinned");
  if (item.useCount > 0) parts.push(`used ${plural(item.useCount, "time", "times")}`);
  return parts.join(" · ");
}

interface MemoryCardProps {
  item: MemoryItem;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function MemoryCard({ item, onOpenMemory, s }: MemoryCardProps) {
  const isMemory = item.kind === "memory";
  return (
    <Pressable
      style={s.card}
      disabled={!isMemory}
      onPress={() => onOpenMemory(Number(item.id))}
      accessibilityRole={isMemory ? "button" : undefined}
      accessibilityLabel={isMemory ? `Open memory ${item.title}` : `Session ${item.title}`}
    >
      <Text style={s.text}>{item.title}</Text>
      <Text style={s.muted}>{cardMeta(item)}</Text>
      <Text style={s.muted} numberOfLines={3}>
        {item.preview}
      </Text>
    </Pressable>
  );
}

function AddMemoryForm({ projectId, s }: { projectId: string | null; s: Styles }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [global, setGlobal] = useState(projectId === null);
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
  const remaining = MAX_CONTENT_CHARS - content.length;
  return (
    <View style={[s.card, { marginTop: 8 }]}>
      <Text style={s.text}>Add a memory</Text>
      <TextInput
        style={s.input}
        placeholder="Title"
        placeholderTextColor={s.placeholder}
        value={title}
        onChangeText={setTitle}
        maxLength={200}
        accessibilityLabel="Memory title"
      />
      <TextInput
        style={[s.input, { minHeight: 64 }]}
        placeholder="What happened, why it matters, and where"
        placeholderTextColor={s.placeholder}
        value={content}
        onChangeText={setContent}
        maxLength={MAX_CONTENT_CHARS}
        multiline
        accessibilityLabel="Memory content"
      />
      {remaining <= SHOW_REMAINING_WITHIN ? (
        <Text style={s.muted}>{plural(remaining, "character left", "characters left")}</Text>
      ) : null}
      <View style={s.row}>
        <Chip
          label="Project"
          active={!global}
          disabled={projectId === null}
          onPress={() => setGlobal(false)}
          accessibilityLabel="Save to this project"
          s={s}
        />
        <Chip
          label="Global"
          active={global}
          onPress={() => setGlobal(true)}
          accessibilityLabel="Save to global memory"
          s={s}
        />
        <Chip
          label={mutation.isPending ? "Saving…" : "Save"}
          active
          disabled={disabled}
          onPress={() => mutation.mutate()}
          accessibilityLabel="Save memory"
          s={s}
        />
      </View>
      {mutation.data ? <Text style={s.muted}>{mutation.data.message}</Text> : null}
      {mutation.error ? <Text style={s.danger}>{String(mutation.error)}</Text> : null}
    </View>
  );
}
