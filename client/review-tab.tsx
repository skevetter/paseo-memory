import { useRpc } from "@getpaseo/plugin/client";
import { type UseMutationResult, useMutation, useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import {
  archiveMemoryRpc,
  dismissPairRpc,
  keepMemoryRpc,
  type MemoryItem,
  mergeMemoryRpc,
  type UpkeepList,
  upkeepListRpc,
  upkeepRunRpc,
} from "../shared/contracts";
import { cardMeta } from "./memories-tab";
import { formatDateTime, plural, QUERY_ROOT, type Styles, useRefresh } from "./panel-styles";
import { Chip, Link, QueryState } from "./panel-ui";

type Duplicate = UpkeepList["duplicates"][number];
type Contradiction = UpkeepList["contradictions"][number];
type PairMemory = Duplicate["a"];
type Action = UseMutationResult<unknown, Error, () => Promise<unknown>>;

interface ReviewTabProps {
  projectId: string | null;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

interface SectionProps {
  list: UpkeepList;
  action: Action;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

export function ReviewTab({ projectId, onOpenMemory, s }: ReviewTabProps) {
  const upkeep = useRpc(upkeepListRpc);
  const refresh = useRefresh();
  const result = useQuery({
    queryKey: [QUERY_ROOT, "upkeep", projectId],
    queryFn: () => upkeep({ paseoProjectId: projectId }),
  });
  const action: Action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => void refresh(),
  });
  const list = result.data;
  return (
    <>
      <CheckNow lastRunAt={list?.lastRunAt ?? null} s={s} />
      <QueryState loading={result.isLoading} error={result.error} empty={false} emptyText="" s={s} />
      {action.error ? <Text style={s.danger}>{String(action.error)}</Text> : null}
      {list ? (
        <>
          <DuplicateSection list={list} action={action} onOpenMemory={onOpenMemory} s={s} />
          <ContradictionSection list={list} action={action} onOpenMemory={onOpenMemory} s={s} />
          <StaleSection list={list} action={action} onOpenMemory={onOpenMemory} s={s} />
        </>
      ) : null}
    </>
  );
}

function CheckNow({ lastRunAt, s }: { lastRunAt: string | null; s: Styles }) {
  const run = useRpc(upkeepRunRpc);
  const refresh = useRefresh();
  const check = useMutation({ mutationFn: () => run({}), onSuccess: () => void refresh() });
  const found = check.data;
  return (
    <View style={s.section}>
      <View style={s.row}>
        <Chip
          label={check.isPending ? "Checking…" : "Check now"}
          active
          disabled={check.isPending}
          onPress={() => check.mutate()}
          accessibilityLabel="Check memories for duplicates, contradictions and stale entries"
          s={s}
        />
        <Text style={s.muted}>
          {lastRunAt ? `Last checked ${formatDateTime(lastRunAt)}` : "Not checked yet."}
        </Text>
      </View>
      {found ? (
        <Text style={s.muted}>
          Merged {found.merged}. Found {plural(found.duplicates, "possible duplicate", "possible duplicates")}
          , {plural(found.contradictions, "contradiction", "contradictions")} and{" "}
          {plural(found.stale, "stale memory", "stale memories")}.
        </Text>
      ) : null}
      {check.error ? <Text style={s.danger}>{String(check.error)}</Text> : null}
    </View>
  );
}

interface PairTitlesProps {
  a: PairMemory;
  b: PairMemory;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function PairTitles({ a, b, onOpenMemory, s }: PairTitlesProps) {
  return (
    <>
      {[a, b].map((memory) => (
        <Link
          key={memory.id}
          label={`#${memory.id} ${memory.title}`}
          onPress={() => onOpenMemory(memory.id)}
          accessibilityLabel={`Open memory ${memory.id}`}
          s={s}
        />
      ))}
    </>
  );
}

function pairMeta(pair: Pick<Duplicate, "similarity" | "sameTopic">): string {
  const parts: string[] = [];
  if (pair.similarity !== null) parts.push(`${Math.round(pair.similarity * 100)}% similar`);
  if (pair.sameTopic) parts.push("same topic");
  return parts.join(" · ");
}

function DuplicateSection({ list, action, onOpenMemory, s }: SectionProps) {
  const dismiss = useRpc(dismissPairRpc);
  const merge = useRpc(mergeMemoryRpc);
  return (
    <View style={s.section}>
      <Text style={s.heading}>Possible duplicates</Text>
      {list.mode === "off" ? (
        <Text style={s.muted}>Duplicate checks are off. Turn them on in the Upkeep settings.</Text>
      ) : null}
      {list.mode !== "off" && list.duplicates.length === 0 ? (
        <Text style={s.muted}>No possible duplicates.</Text>
      ) : null}
      {list.duplicates.map((pair) => {
        const sourceId = pair.targetId === pair.a.id ? pair.b.id : pair.a.id;
        return (
          <View key={`${pair.a.id}:${pair.b.id}`} style={s.card}>
            <PairTitles a={pair.a} b={pair.b} onOpenMemory={onOpenMemory} s={s} />
            <Text style={s.muted}>{pairMeta(pair)}</Text>
            <View style={s.row}>
              <Link
                label={`Merge into #${pair.targetId}`}
                disabled={action.isPending}
                onPress={() => action.mutate(() => merge({ sourceId, targetId: pair.targetId }))}
                accessibilityLabel={`Merge memory ${sourceId} into memory ${pair.targetId}`}
                s={s}
              />
              <Link
                label="Keep both"
                disabled={action.isPending}
                onPress={() => action.mutate(() => dismiss({ a: pair.a.id, b: pair.b.id }))}
                accessibilityLabel={`Keep memories ${pair.a.id} and ${pair.b.id}`}
                s={s}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ContradictionSection({ list, action, onOpenMemory, s }: SectionProps) {
  const dismiss = useRpc(dismissPairRpc);
  return (
    <View style={s.section}>
      <Text style={s.heading}>Possible contradictions</Text>
      <Text style={s.muted}>These memories disagree on a value. They are never merged automatically.</Text>
      {list.contradictions.length === 0 ? <Text style={s.muted}>No possible contradictions.</Text> : null}
      {list.contradictions.map((pair) => (
        <View key={`${pair.a.id}:${pair.b.id}`} style={s.card}>
          <PairTitles a={pair.a} b={pair.b} onOpenMemory={onOpenMemory} s={s} />
          <ContradictionValues pair={pair} s={s} />
          <Link
            label="Keep both"
            disabled={action.isPending}
            onPress={() => action.mutate(() => dismiss({ a: pair.a.id, b: pair.b.id }))}
            accessibilityLabel={`Keep memories ${pair.a.id} and ${pair.b.id}`}
            s={s}
          />
        </View>
      ))}
    </View>
  );
}

function ContradictionValues({ pair, s }: { pair: Contradiction; s: Styles }) {
  const meta = pairMeta(pair);
  return (
    <>
      <Text style={s.text}>
        #{pair.a.id} says {pair.values.a.join(", ")}
      </Text>
      <Text style={s.text}>
        #{pair.b.id} says {pair.values.b.join(", ")}
      </Text>
      {meta ? <Text style={s.muted}>{meta}</Text> : null}
    </>
  );
}

function StaleSection({ list, action, onOpenMemory, s }: SectionProps) {
  return (
    <View style={s.section}>
      <Text style={s.heading}>Stale</Text>
      <Text style={s.muted}>
        Memories nobody used or edited for {plural(list.staleDays, "day", "days")}. Pinned memories never go
        stale.
      </Text>
      {list.stale.length === 0 ? <Text style={s.muted}>No stale memories.</Text> : null}
      {list.stale.map((item) => (
        <StaleCard key={item.id} item={item} action={action} onOpenMemory={onOpenMemory} s={s} />
      ))}
    </View>
  );
}

interface StaleCardProps {
  item: MemoryItem;
  action: Action;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function StaleCard({ item, action, onOpenMemory, s }: StaleCardProps) {
  const keep = useRpc(keepMemoryRpc);
  const archive = useRpc(archiveMemoryRpc);
  const id = Number(item.id);
  return (
    <View style={s.card}>
      <Link
        label={item.title}
        onPress={() => onOpenMemory(id)}
        accessibilityLabel={`Open memory ${item.id}`}
        s={s}
      />
      <Text style={s.muted}>{cardMeta(item)}</Text>
      <View style={s.row}>
        <Link
          label="Keep"
          disabled={action.isPending}
          onPress={() => action.mutate(() => keep({ id }))}
          accessibilityLabel={`Keep memory ${item.id}`}
          s={s}
        />
        <Link
          label="Archive"
          danger
          disabled={action.isPending}
          onPress={() => action.mutate(() => archive({ id }))}
          accessibilityLabel={`Archive memory ${item.id}`}
          s={s}
        />
      </View>
    </View>
  );
}
