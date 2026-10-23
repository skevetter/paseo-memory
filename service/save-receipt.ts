import type { ProjectRef, SaveResult } from "./store";

export function formatSave(result: SaveResult, project: ProjectRef | null): string {
  if (result.status === "near_duplicate") {
    return (
      `near_duplicate: not saved. #${result.id} "${result.title}" already says this (similarity ${result.similarity}). ` +
      `Call memory_update with id ${result.id} to change it.`
    );
  }
  if (result.status === "possible_duplicate") {
    const candidates = result.candidates
      .map((c) => `#${c.id} ${c.title} (similarity ${c.similarity})`)
      .join("\n");
    return `possible_duplicate: not saved. Similar memories:\n${candidates}\nUpdate one with memory_update, or retry with force=true.`;
  }
  return `${result.status}: #${result.id} (${project ? `project: ${project.name}` : "global"})`;
}
