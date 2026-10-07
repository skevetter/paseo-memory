import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MemoryPanel } from "./client/memory-panel";
import { MemorySettingsScreen } from "./client/settings-screen";
import { memoryAttachments, saveMemoryRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addWorkspacePanel({
      id: "memory",
      title: "Memory",
      icon: "Brain",
      context: "workspace",
      Component: MemoryPanel,
    }),
    client.addSettingsScreen({
      id: "memory",
      title: "Memory",
      icon: "Brain",
      Component: MemorySettingsScreen,
    }),
    client.addAttachmentSource(memoryAttachments),
    client.addSlashCommand({
      name: "remember",
      description: "Saves a note to this project's memory, or to global memory with the global: prefix.",
      argumentHint: "[global:] note text",
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openPanel }) {
        const text = args.trim();
        if (!text) {
          openPanel("memory");
          return;
        }
        const isGlobal = /^global:/i.test(text);
        const body = text.replace(/^global:\s*/i, "");
        await rpc(saveMemoryRpc, {
          title: (body.split("\n")[0] ?? body).slice(0, 120),
          content: body,
          type: "note",
          scope: isGlobal ? "global" : "project",
          paseoProjectId: workspace.projectId,
          pinned: false,
        });
        openPanel("memory");
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
