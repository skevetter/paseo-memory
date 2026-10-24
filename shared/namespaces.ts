import { z } from "zod";

export const MemoryScopeSchema = z.enum(["global", "project", "bot"]);
export type Scope = z.infer<typeof MemoryScopeSchema>;

const NamespaceIdSchema = z.string().min(1).max(200);
export const MemoryNamespaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectKey: NamespaceIdSchema }),
  z.strictObject({ kind: z.literal("bot"), botId: NamespaceIdSchema }),
]);
export type MemoryNamespace = z.infer<typeof MemoryNamespaceSchema>;

export interface NamespaceColumns {
  scope: Scope;
  project_key: string | null;
  bot_id: string | null;
}

// A pre-bot canonical revision can omit bot_id, but never infer an unknown legacy scope.
export function namespaceOf(row: {
  scope: unknown;
  project_key: unknown;
  bot_id?: unknown;
}): MemoryNamespace | null {
  const botId = row.bot_id ?? null;
  if (row.scope === "global" && row.project_key === null && botId === null) return { kind: "global" };
  if (
    row.scope === "project" &&
    typeof row.project_key === "string" &&
    row.project_key.length > 0 &&
    botId === null
  )
    return { kind: "project", projectKey: row.project_key };
  if (row.scope === "bot" && row.project_key === null && typeof botId === "string" && botId.length > 0)
    return { kind: "bot", botId };
  return null;
}

export function namespaceColumns(namespace: MemoryNamespace): NamespaceColumns {
  return {
    scope: namespace.kind,
    project_key: namespace.kind === "project" ? namespace.projectKey : null,
    bot_id: namespace.kind === "bot" ? namespace.botId : null,
  };
}

export function namespaceKey(namespace: MemoryNamespace): string {
  switch (namespace.kind) {
    case "global":
      return "global";
    case "project":
      return `project:${namespace.projectKey}`;
    case "bot":
      return `bot:${namespace.botId}`;
  }
}

export function sameNamespace(left: MemoryNamespace, right: MemoryNamespace): boolean {
  if (left.kind === "global") return right.kind === "global";
  if (left.kind === "project") return right.kind === "project" && left.projectKey === right.projectKey;
  return right.kind === "bot" && left.botId === right.botId;
}
