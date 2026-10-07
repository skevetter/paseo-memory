import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { type UseMutationResult, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
  deleteMemoryRpc,
  MAX_CONTENT_CHARS,
  MEMORY_TYPES,
  type MemoryDetail,
  memoryDetailRpc,
  mergeMemoryRpc,
  restoreMemoryRpc,
  updateMemoryRpc,
} from "../shared/contracts";
import { formatDate, formatDateTime, plural, QUERY_ROOT, type Styles, useRefresh } from "./panel-styles";
import { Chip, Link, QueryState } from "./panel-ui";

type Memory = NonNullable<MemoryDetail["memory"]>;
type MemoryType = (typeof MEMORY_TYPES)[number];
type Scope = Memory["scope"];

interface DetailProps {
  id: number;
  projectId: string | null;
  onBack: () => void;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

type UpdateInput = RpcInput<typeof updateMemoryRpc>;

// The editor remounts whenever the memory changes, so the save result lives above it.
interface BodyProps extends DetailProps {
  save: UseMutationResult<RpcOutput<typeof updateMemoryRpc>, Error, UpdateInput>;
}

export function MemoryDetailView({ id, projectId, onBack, onOpenMemory, s }: DetailProps) {
  const detail = useRpc(memoryDetailRpc);
  const update = useRpc(updateMemoryRpc);
  const refresh = useRefresh();
  const save = useMutation({
    mutationFn: (input: UpdateInput) => update(input),
    onSuccess: () => void refresh(),
  });
  const result = useQuery({
    queryKey: [QUERY_ROOT, "detail", id],
    queryFn: () => detail({ id }),
  });
  return (
    <>
      <Link label="Back" onPress={onBack} accessibilityLabel="Back to the list" s={s} />
      <QueryState loading={result.isLoading} error={result.error} empty={false} emptyText="" s={s} />
      {result.data ? (
        <DetailBody data={result.data} props={{ id, projectId, onBack, onOpenMemory, s, save }} />
      ) : null}
    </>
  );
}

function DetailBody({ data, props }: { data: MemoryDetail; props: BodyProps }) {
  const { s, onOpenMemory } = props;
  const { memory, mergedInto, archived } = data;
  if (memory) {
    return (
      <>
        <MemoryEditor key={`${memory.id}:${memory.updatedAt}`} memory={memory} props={props} />
        <MemoryFacts memory={memory} s={s} />
        <VersionList memoryId={memory.id} versions={data.versions} s={s} />
        <DuplicateList memoryId={memory.id} duplicates={data.duplicates} onOpenMemory={onOpenMemory} s={s} />
      </>
    );
  }
  if (archived) return <Text style={s.muted}>This memory was archived.</Text>;
  if (mergedInto === null) return <Text style={s.muted}>This memory was deleted.</Text>;
  return (
    <>
      <Text style={s.muted}>This memory was merged into #{mergedInto}.</Text>
      <Link
        label={`Open #${mergedInto}`}
        onPress={() => onOpenMemory(mergedInto)}
        accessibilityLabel={`Open memory ${mergedInto}`}
        s={s}
      />
    </>
  );
}

function MemoryEditor({ memory, props }: { memory: Memory; props: BodyProps }) {
  const { projectId, onBack, save, s } = props;
  const [title, setTitle] = useState(memory.title);
  const [content, setContent] = useState(memory.content);
  const [type, setType] = useState<MemoryType | null>(MEMORY_TYPES.find((t) => t === memory.type) ?? null);
  const [pinned, setPinned] = useState(memory.pinned);
  const [scope, setScope] = useState<Scope>(memory.scope);
  const remove = useRpc(deleteMemoryRpc);
  const refresh = useRefresh();
  const submit = () =>
    save.mutate({
      id: memory.id,
      title: title.trim(),
      content: content.trim(),
      type: type ?? undefined,
      pinned,
      ...(scope === memory.scope ? {} : { scope, paseoProjectId: scope === "project" ? projectId : null }),
    });
  const del = useMutation({
    mutationFn: () => remove({ id: memory.id }),
    onSuccess: () => {
      void refresh();
      onBack();
    },
  });
  const invalid = !title.trim() || !content.trim();
  return (
    <View style={s.card}>
      <TextInput
        style={s.input}
        value={title}
        onChangeText={setTitle}
        maxLength={200}
        accessibilityLabel="Memory title"
      />
      <TextInput
        style={[s.input, { minHeight: 120 }]}
        value={content}
        onChangeText={setContent}
        maxLength={MAX_CONTENT_CHARS}
        multiline
        accessibilityLabel="Memory content"
      />
      <TypeChips type={type} onChange={setType} s={s} />
      <ScopeChips
        scope={scope}
        onScope={setScope}
        pinned={pinned}
        onPinned={setPinned}
        projectId={projectId}
        s={s}
      />
      <View style={s.row}>
        <Chip
          label={save.isPending ? "Saving…" : "Save"}
          active
          disabled={invalid || save.isPending}
          onPress={submit}
          accessibilityLabel="Save changes"
          s={s}
        />
        <Link label="Delete" danger onPress={() => del.mutate()} accessibilityLabel="Delete memory" s={s} />
      </View>
      {save.data ? <Text style={save.data.ok ? s.muted : s.danger}>{save.data.message}</Text> : null}
      {save.error ? <Text style={s.danger}>{String(save.error)}</Text> : null}
      {del.error ? <Text style={s.danger}>{String(del.error)}</Text> : null}
    </View>
  );
}

interface TypeChipsProps {
  type: MemoryType | null;
  onChange: (type: MemoryType) => void;
  s: Styles;
}

function TypeChips({ type, onChange, s }: TypeChipsProps) {
  return (
    <View style={s.row}>
      {MEMORY_TYPES.map((value) => (
        <Chip
          key={value}
          label={value}
          active={type === value}
          onPress={() => onChange(value)}
          accessibilityLabel={`Set type to ${value}`}
          s={s}
        />
      ))}
    </View>
  );
}

interface ScopeChipsProps {
  scope: Scope;
  onScope: (scope: Scope) => void;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  projectId: string | null;
  s: Styles;
}

function ScopeChips({ scope, onScope, pinned, onPinned, projectId, s }: ScopeChipsProps) {
  return (
    <View style={s.row}>
      <Chip
        label="Project"
        active={scope === "project"}
        disabled={projectId === null}
        onPress={() => onScope("project")}
        accessibilityLabel="Move to this project"
        s={s}
      />
      <Chip
        label="Global"
        active={scope === "global"}
        onPress={() => onScope("global")}
        accessibilityLabel="Make global"
        s={s}
      />
      <Chip
        label="Pinned"
        active={pinned}
        onPress={() => onPinned(!pinned)}
        accessibilityLabel={pinned ? "Unpin memory" : "Pin memory"}
        s={s}
      />
    </View>
  );
}

function memoryFacts(memory: Memory): string[] {
  const where = memory.scope === "global" ? "Global" : `Project ${memory.projectName ?? ""}`.trim();
  const origin = [memory.source, memory.agentId, memory.provider].filter(Boolean).join(" · ");
  const lastUsed = memory.lastUsedAt ? `, last on ${formatDateTime(memory.lastUsedAt)}` : "";
  return [
    `#${memory.id} · ${memory.type} · ${where}`,
    memory.topicKey ? `Topic: ${memory.topicKey}` : null,
    `Created ${formatDateTime(memory.createdAt)} · Updated ${formatDateTime(memory.updatedAt)}`,
    origin ? `Saved by ${origin}` : null,
    `Used ${plural(memory.useCount, "time", "times")}${lastUsed}`,
    `Shown ${plural(memory.shownCount, "time", "times")} · opened ${plural(memory.openedCount, "time", "times")}`,
    plural(memory.revisionCount, "revision", "revisions"),
  ].filter((line): line is string => line !== null);
}

function MemoryFacts({ memory, s }: { memory: Memory; s: Styles }) {
  return (
    <View style={s.section}>
      {memoryFacts(memory).map((line) => (
        <Text key={line} style={s.muted}>
          {line}
        </Text>
      ))}
    </View>
  );
}

interface VersionListProps {
  memoryId: number;
  versions: MemoryDetail["versions"];
  s: Styles;
}

function VersionList({ memoryId, versions, s }: VersionListProps) {
  const restore = useRpc(restoreMemoryRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: (version: number) => restore({ id: memoryId, version }),
    onSuccess: () => void refresh(),
  });
  if (versions.length === 0) return null;
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  return (
    <View style={s.section}>
      <Text style={s.heading}>Version history, newest first</Text>
      {mutation.error ? <Text style={s.danger}>{String(mutation.error)}</Text> : null}
      {newestFirst.map((v) => (
        <View key={v.version} style={s.card}>
          <Text style={s.muted}>
            Version {v.version} · {formatDate(v.createdAt)}
          </Text>
          <Text style={s.text}>{v.title}</Text>
          <Text style={s.muted} numberOfLines={3}>
            {v.content}
          </Text>
          <Link
            label="Restore"
            disabled={mutation.isPending}
            onPress={() => mutation.mutate(v.version)}
            accessibilityLabel={`Restore version ${v.version}`}
            s={s}
          />
        </View>
      ))}
    </View>
  );
}

interface DuplicateListProps {
  memoryId: number;
  duplicates: MemoryDetail["duplicates"];
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function DuplicateList({ memoryId, duplicates, onOpenMemory, s }: DuplicateListProps) {
  const merge = useRpc(mergeMemoryRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: (targetId: number) => merge({ sourceId: memoryId, targetId }),
    onSuccess: (result, targetId) => {
      void refresh();
      if (result.ok) onOpenMemory(targetId);
    },
  });
  if (duplicates.length === 0) return null;
  return (
    <View style={s.section}>
      <Text style={s.heading}>Possible duplicates</Text>
      {mutation.data && !mutation.data.ok ? <Text style={s.danger}>{mutation.data.message}</Text> : null}
      {mutation.error ? <Text style={s.danger}>{String(mutation.error)}</Text> : null}
      {duplicates.map((d) => (
        <View key={d.id} style={s.card}>
          <Text style={s.text}>
            #{d.id} {d.title}
          </Text>
          <Text style={s.muted}>Similarity {d.similarity.toFixed(2)}</Text>
          <Link
            label={`Merge into #${d.id}`}
            disabled={mutation.isPending}
            onPress={() => mutation.mutate(d.id)}
            accessibilityLabel={`Merge this memory into memory ${d.id}`}
            s={s}
          />
        </View>
      ))}
    </View>
  );
}
