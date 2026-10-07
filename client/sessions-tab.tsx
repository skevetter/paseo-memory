import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput } from "react-native";
import { type SessionItem, sessionsRpc } from "../shared/contracts";
import { formatDate, plural, QUERY_ROOT, type Styles } from "./panel-styles";
import { QueryState } from "./panel-ui";

interface SessionsTabProps {
  projectId: string | null;
  onOpenAgent: (agentId: string) => void;
  s: Styles;
}

export function SessionsTab({ projectId, onOpenAgent, s }: SessionsTabProps) {
  const [query, setQuery] = useState("");
  const sessions = useRpc(sessionsRpc);
  const result = useQuery({
    queryKey: [QUERY_ROOT, "sessions", projectId, query],
    queryFn: () => sessions({ paseoProjectId: projectId, query, limit: 30 }),
  });
  const items = result.data?.items ?? [];
  return (
    <>
      <TextInput
        style={s.input}
        placeholder="Search sessions"
        placeholderTextColor={s.placeholder}
        value={query}
        onChangeText={setQuery}
        accessibilityLabel="Search sessions"
      />
      <QueryState
        loading={result.isLoading}
        error={result.error}
        empty={items.length === 0}
        emptyText="No sessions."
        s={s}
      />
      {items.map((item) => (
        <SessionCard key={`${item.agentId}:${item.updatedAt}`} item={item} onOpenAgent={onOpenAgent} s={s} />
      ))}
    </>
  );
}

function sessionMeta(item: SessionItem): string {
  const parts = [plural(item.turns, "turn", "turns"), `updated ${formatDate(item.updatedAt)}`];
  if (item.provider) parts.unshift(item.provider);
  if (item.files.length > 0) parts.push(plural(item.files.length, "file edited", "files edited"));
  return parts.join(" · ");
}

interface SessionCardProps {
  item: SessionItem;
  onOpenAgent: (agentId: string) => void;
  s: Styles;
}

function SessionCard({ item, onOpenAgent, s }: SessionCardProps) {
  const title = item.title ?? item.lastPrompt ?? "Untitled session";
  return (
    <Pressable
      style={s.card}
      onPress={() => onOpenAgent(item.agentId)}
      accessibilityRole="button"
      accessibilityLabel={`Show memory use for ${title}`}
    >
      <Text style={s.text} numberOfLines={2}>
        {title}
      </Text>
      <Text style={s.muted}>{sessionMeta(item)}</Text>
      {item.summary ? (
        <Text style={s.text} numberOfLines={4}>
          Summary: {item.summary}
        </Text>
      ) : null}
      {item.outcomes ? <Text style={s.muted}>{item.outcomes}</Text> : null}
      {item.lastPrompt ? (
        <Text style={s.muted} numberOfLines={3}>
          Request: {item.lastPrompt}
        </Text>
      ) : null}
      {item.lastReply ? (
        <Text style={s.muted} numberOfLines={3}>
          Reply: {item.lastReply}
        </Text>
      ) : null}
    </Pressable>
  );
}
