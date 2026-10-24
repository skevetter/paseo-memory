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
  undoMergeRpc,
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
        <VersionList
          memoryId={memory.id}
          expectedRevision={memory.recordRevision}
          versions={data.versions}
          s={s}
        />
        <DuplicateList
          memoryId={memory.id}
          revision={memory.recordRevision}
          duplicates={data.duplicates}
          s={s}
        />
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
      {data.mergeId === null || data.mergeRevisions === null ? null : (
        <UndoMerge mergeId={data.mergeId} revisions={data.mergeRevisions} s={s} />
      )}
    </>
  );
}

function UndoMerge({
  mergeId,
  revisions,
  s,
}: {
  mergeId: number;
  revisions: NonNullable<MemoryDetail["mergeRevisions"]>;
  s: Styles;
}) {
  const undo = useRpc(undoMergeRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: () => undo({ mergeId, ...revisions }),
    onSuccess: () => void refresh(),
  });
  return (
    <>
      <Link
        label="Undo merge"
        disabled={mutation.isPending}
        onPress={() => mutation.mutate()}
        accessibilityLabel="Restore this memory as its own entry"
        s={s}
      />
      {mutation.data && !mutation.data.ok ? <Text style={s.danger}>{mutation.data.message}</Text> : null}
      {mutation.error ? <Text style={s.danger}>{String(mutation.error)}</Text> : null}
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
  const [botId, setBotId] = useState(memory.botId ?? "");
  const remove = useRpc(deleteMemoryRpc);
  const refresh = useRefresh();
  const bot = botId.trim();
  const namespaceChanged = namespaceEdited(memory, scope, bot);
  const submit = () =>
    save.mutate({
      id: memory.id,
      expectedRevision: memory.recordRevision,
      title: title.trim(),
      content: content.trim(),
      type: type ?? undefined,
      pinned,
      ...(namespaceChanged ? namespacePayload(scope, projectId, bot) : {}),
    });
  const del = useMutation({
    mutationFn: () => remove({ id: memory.id, expectedRevision: memory.recordRevision }),
    onSuccess: () => {
      void refresh();
      onBack();
    },
  });
  const invalid = editorInvalid(title, content, scope, bot);
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
        botId={botId}
        onBotId={setBotId}
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

function namespaceEdited(memory: Memory, scope: Scope, bot: string): boolean {
  return scope !== memory.scope || (scope === "bot" && bot !== memory.botId);
}

function editorInvalid(title: string, content: string, scope: Scope, bot: string): boolean {
  return !title.trim() || !content.trim() || (scope === "bot" && bot.length === 0);
}

function namespacePayload(scope: Scope, projectId: string | null, botId: string) {
  if (scope === "project") return { scope, paseoProjectId: projectId, botId: null };
  if (scope === "bot") return { scope, paseoProjectId: null, botId };
  return { scope, paseoProjectId: null, botId: null };
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
  botId: string;
  onBotId: (botId: string) => void;
  s: Styles;
}

function ScopeChips({ scope, onScope, pinned, onPinned, projectId, botId, onBotId, s }: ScopeChipsProps) {
  return (
    <>
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
          label="Bot"
          active={scope === "bot"}
          onPress={() => onScope("bot")}
          accessibilityLabel="Move to bot memory"
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
      {scope === "bot" ? (
        <TextInput
          style={s.input}
          placeholder="Bot ID"
          placeholderTextColor={s.placeholder}
          value={botId}
          onChangeText={onBotId}
          maxLength={200}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Bot ID"
        />
      ) : null}
    </>
  );
}

function memoryWhere(memory: Memory): string {
  if (memory.scope === "global") return "Global";
  if (memory.scope === "bot") return memory.botId ? `Bot ${memory.botId}` : "Bot";
  return `Project ${memory.projectName ?? ""}`.trim();
}

function memoryFacts(memory: Memory): string[] {
  const where = memoryWhere(memory);
  const origin = [memory.source, memory.agentId, memory.provider].filter(Boolean).join(" · ");
  const lastUsed = memory.lastUsedAt ? `, last on ${formatDateTime(memory.lastUsedAt)}` : "";
  return [
    `#${memory.id} · ${memory.type} · ${where}`,
    memory.topicKey ? `Topic: ${memory.topicKey}` : null,
    `Created ${formatDateTime(memory.createdAt)} · Updated ${formatDateTime(memory.updatedAt)}`,
    origin ? `Saved by ${origin}` : null,
    `Legacy activity ${memory.useCount}${lastUsed} (not validated application)`,
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
  expectedRevision: number;
  versions: MemoryDetail["versions"];
  s: Styles;
}

function VersionList({ memoryId, expectedRevision, versions, s }: VersionListProps) {
  const restore = useRpc(restoreMemoryRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: (version: number) => restore({ id: memoryId, version, expectedRevision }),
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
  revision: number;
  duplicates: MemoryDetail["duplicates"];
  s: Styles;
}

function DuplicateList({ memoryId, revision, duplicates, s }: DuplicateListProps) {
  const merge = useRpc(mergeMemoryRpc);
  const refresh = useRefresh();
  const mutation = useMutation({
    mutationFn: (target: { id: number; revision: number }) =>
      merge({
        sourceId: memoryId,
        targetId: target.id,
        sourceRevision: revision,
        targetRevision: target.revision,
      }),
    onSuccess: () => void refresh(),
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
            onPress={() => mutation.mutate({ id: d.id, revision: d.revision })}
            accessibilityLabel={`Merge this memory into memory ${d.id}`}
            s={s}
          />
        </View>
      ))}
    </View>
  );
}
