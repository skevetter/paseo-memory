import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { type AgentAudit, type AuditEvent, agentAuditRpc, workspaceAgentsRpc } from "../shared/contracts";
import { formatDateTime, plural, QUERY_ROOT, type Styles } from "./panel-styles";
import { Chip, QueryState } from "./panel-ui";

type AuditMemory = AuditEvent["memories"][number];

const KIND_LABELS: Record<AuditEvent["kind"], string> = {
  inject: "Start",
  context: "Context",
  search: "Search",
  get: "Get",
  save: "Save",
  update: "Update",
  delete: "Delete",
};

interface AgentTabProps {
  workspaceId: string;
  // Null follows the most recently active agent.
  agentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

export function AgentTab({ workspaceId, agentId, onSelectAgent, onOpenMemory, s }: AgentTabProps) {
  const list = useRpc(workspaceAgentsRpc);
  const result = useQuery({
    queryKey: [QUERY_ROOT, "agents", workspaceId],
    queryFn: () => list({ workspaceId }),
  });
  const agents = result.data?.agents ?? [];
  const selected = agentId ?? agents[0]?.agentId ?? null;
  return (
    <>
      <QueryState
        loading={result.isLoading}
        error={result.error}
        empty={selected === null}
        emptyText="No agents in this workspace have used memory yet."
        s={s}
      />
      {agents.length > 1 ? (
        <View style={s.row}>
          {agents.map((agent) => (
            <Chip
              key={agent.agentId}
              label={agent.title ?? agent.agentId.slice(0, 8)}
              active={agent.agentId === selected}
              onPress={() => onSelectAgent(agent.agentId)}
              accessibilityLabel={`Show agent ${agent.title ?? agent.agentId}`}
              s={s}
            />
          ))}
        </View>
      ) : null}
      {selected ? <AuditView agentId={selected} onOpenMemory={onOpenMemory} s={s} /> : null}
    </>
  );
}

interface AuditViewProps {
  agentId: string;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function AuditView({ agentId, onOpenMemory, s }: AuditViewProps) {
  const audit = useRpc(agentAuditRpc);
  const result = useQuery({
    queryKey: [QUERY_ROOT, "audit", agentId],
    queryFn: () => audit({ agentId }),
  });
  const data = result.data;
  return (
    <>
      <QueryState loading={result.isLoading} error={result.error} empty={false} emptyText="" s={s} />
      {data ? (
        <>
          <AuditHeader audit={data} s={s} />
          <InjectedSection injected={data.injected} onOpenMemory={onOpenMemory} s={s} />
          <EventTimeline events={data.events} onOpenMemory={onOpenMemory} s={s} />
        </>
      ) : null}
    </>
  );
}

function AuditHeader({ audit, s }: { audit: AgentAudit; s: Styles }) {
  const meta = [
    audit.provider,
    audit.projectName,
    audit.createdAt ? `started ${formatDateTime(audit.createdAt)}` : null,
  ].filter(Boolean);
  return (
    <View style={s.section}>
      <Text style={s.title}>{audit.title ?? audit.agentId}</Text>
      {meta.length > 0 ? <Text style={s.muted}>{meta.join(" · ")}</Text> : null}
      {audit.linked ? null : <Text style={s.muted}>Tool calls appear after this agent's first message.</Text>}
    </View>
  );
}

interface InjectedProps {
  injected: AgentAudit["injected"];
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function InjectedSection({ injected, onOpenMemory, s }: InjectedProps) {
  return (
    <View style={s.section}>
      <Text style={s.heading}>Injected at start</Text>
      {injected ? (
        <>
          <Text style={s.muted}>
            {injected.chars} of {plural(injected.budget, "character", "characters")}
          </Text>
          {injected.memories.map((memory) => (
            <MemoryRef key={memory.id} memory={memory} onOpenMemory={onOpenMemory} s={s} />
          ))}
          {injected.sessions.map((session) => (
            <Text key={session.id} style={s.muted}>
              Session: {session.title ?? "untitled"}
            </Text>
          ))}
        </>
      ) : (
        <Text style={s.muted}>Nothing was injected when this agent started.</Text>
      )}
    </View>
  );
}

interface TimelineProps {
  events: AuditEvent[];
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function EventTimeline({ events, onOpenMemory, s }: TimelineProps) {
  const newestFirst = [...events].sort((a, b) => b.id - a.id);
  return (
    <View style={s.section}>
      <Text style={s.heading}>Tool calls, newest first</Text>
      {newestFirst.length === 0 ? <Text style={s.muted}>No tool calls yet.</Text> : null}
      {newestFirst.map((event) => (
        <View key={event.id} style={s.card}>
          <Text style={s.muted}>
            {formatDateTime(event.at)} · {KIND_LABELS[event.kind]}
          </Text>
          {event.query ? <Text style={s.text}>“{event.query}”</Text> : null}
          {event.summary ? <Text style={s.muted}>{event.summary}</Text> : null}
          {event.memories.map((memory) => (
            <MemoryRef key={memory.id} memory={memory} onOpenMemory={onOpenMemory} s={s} />
          ))}
        </View>
      ))}
    </View>
  );
}

function refDetail(memory: AuditMemory): string {
  if (memory.score !== null) return ` · ${memory.score.toFixed(2)}`;
  return memory.status ? ` · ${memory.status}` : "";
}

interface MemoryRefProps {
  memory: AuditMemory;
  onOpenMemory: (id: number) => void;
  s: Styles;
}

function MemoryRef({ memory, onOpenMemory, s }: MemoryRefProps) {
  return (
    <Pressable
      onPress={() => onOpenMemory(memory.id)}
      accessibilityRole="button"
      accessibilityLabel={`Open memory ${memory.id}`}
    >
      <Text style={s.action}>
        #{memory.id} {memory.title ?? "deleted"}
        <Text style={s.muted}>{refDetail(memory)}</Text>
      </Text>
    </Pressable>
  );
}
