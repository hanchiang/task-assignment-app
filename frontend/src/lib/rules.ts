// Pure copy of the backend's assignment rule, used only to hide choices the backend would reject,
// plus the subtask progress count. The backend stays the guard (docs/frontend.md).
import type { Developer, Id, TaskNode } from "../api/types";

export type Progress = { done: number; total: number };

// A developer qualifies with every required skill. A task with no skills has no qualifying developer.
export function qualifies(developer: Developer, skillIds: Id[]): boolean {
  if (skillIds.length === 0) return false;
  const owned = new Set(developer.skills.map((skill) => skill.id));
  return skillIds.every((id) => owned.has(id));
}

export function qualifyingDevelopers(developers: Developer[], skillIds: Id[]): Developer[] {
  return developers.filter((developer) => qualifies(developer, skillIds));
}

// Direct subtasks only, matching the Done rule: a Done task never sits above unfinished work.
export function doneProgress(task: TaskNode): Progress {
  const done = task.subtasks.filter((subtask) => subtask.status === "DONE").length;
  return { done, total: task.subtasks.length };
}
