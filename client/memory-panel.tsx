import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { AgentTab } from "./agent-audit";
import { MemoriesTab } from "./memories-tab";
import { MemoryDetailView } from "./memory-detail";
import { panelStyles, type Styles } from "./panel-styles";
import { Chip } from "./panel-ui";
import { SessionsTab } from "./sessions-tab";

type Tab = "memories" | "agent" | "sessions";

const TABS: readonly { value: Tab; label: string }[] = [
  { value: "memories", label: "Memories" },
  { value: "agent", label: "This agent" },
  { value: "sessions", label: "Sessions" },
];

interface Navigation {
  tab: Tab;
  detailId: number | null;
  agentId: string | null;
}

interface BodyProps {
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  nav: Navigation;
  setNav: (update: (nav: Navigation) => Navigation) => void;
  s: Styles;
}

export function MemoryPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    projectId: w.projectId,
    name: w.projectDisplayName,
  }));
  const s = useMemo(() => panelStyles(theme), [theme]);
  const [nav, setNav] = useState<Navigation>({ tab: "memories", detailId: null, agentId: null });
  return (
    <ScrollView style={s.root} contentContainerStyle={s.pad}>
      <TabRow
        tab={nav.detailId === null ? nav.tab : null}
        onChange={(tab) => setNav((n) => ({ ...n, tab, detailId: null }))}
        s={s}
      />
      <PanelBody
        workspaceId={workspaceId}
        projectId={workspace?.projectId ?? null}
        projectName={workspace?.name ?? null}
        nav={nav}
        setNav={setNav}
        s={s}
      />
    </ScrollView>
  );
}

function PanelBody({ workspaceId, projectId, projectName, nav, setNav, s }: BodyProps) {
  const openMemory = (detailId: number) => setNav((n) => ({ ...n, detailId }));
  const selectAgent = (agentId: string) => setNav(() => ({ tab: "agent", detailId: null, agentId }));
  if (nav.detailId !== null) {
    return (
      <MemoryDetailView
        key={nav.detailId}
        id={nav.detailId}
        projectId={projectId}
        onBack={() => setNav((n) => ({ ...n, detailId: null }))}
        onOpenMemory={openMemory}
        s={s}
      />
    );
  }
  if (nav.tab === "agent") {
    return (
      <AgentTab
        workspaceId={workspaceId}
        agentId={nav.agentId}
        onSelectAgent={selectAgent}
        onOpenMemory={openMemory}
        s={s}
      />
    );
  }
  if (nav.tab === "sessions") return <SessionsTab projectId={projectId} onOpenAgent={selectAgent} s={s} />;
  return <MemoriesTab projectId={projectId} projectName={projectName} onOpenMemory={openMemory} s={s} />;
}

// No tab is active while a memory is open; pressing one returns to its list.
function TabRow({ tab, onChange, s }: { tab: Tab | null; onChange: (tab: Tab) => void; s: Styles }) {
  return (
    <View style={s.row}>
      {TABS.map(({ value, label }) => (
        <Chip
          key={value}
          label={label}
          active={tab === value}
          onPress={() => onChange(value)}
          accessibilityLabel={`Show ${label}`}
          s={s}
        />
      ))}
    </View>
  );
}
