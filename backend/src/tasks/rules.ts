// Every business rule, as pure functions over plain data. Services load the data under the tree lock
// and call these; nothing here touches the database. See docs/requirement.md → Business rules.
import { badRequest, conflict } from "../errors.js";

export const STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
export type Status = (typeof STATUSES)[number];
export type SkillSource = "USER" | "LLM" | "FAILED";

export type NamedRef = { id: string; name: string };

// Skills the task requires that the developer lacks, as names sorted for messages.
export function missingSkills(taskSkills: NamedRef[], developerSkillIds: Set<string>): string[] {
  return taskSkills
    .filter((s) => !developerSkillIds.has(s.id))
    .map((s) => s.name)
    .sort();
}

// Assignment rule: the task has at least one skill, and the developer has every one of them.
export function checkAssignment(
  task: { title: string; skills: NamedRef[] },
  developer: { name: string; skillIds: Set<string> },
  details?: unknown,
): void {
  if (task.skills.length === 0) {
    throw conflict(
      "TASK_HAS_NO_SKILLS",
      `'${task.title}' has no skills yet. Pick its skills before assigning it.`,
      details,
    );
  }
  const missing = missingSkills(task.skills, developer.skillIds);
  if (missing.length > 0) {
    const required = task.skills.map((s) => s.name).sort().join(", ");
    throw conflict(
      "ASSIGNEE_LACKS_SKILLS",
      `${developer.name} cannot take '${task.title}': it requires ${required}, and ${developer.name} lacks ${missing.join(", ")}.`,
      details,
    );
  }
}

// Done rule: only direct subtasks are checked, because a Done task never sits above unfinished work.
export function checkCanBeDone(task: { title: string }, subtasks: { title: string; status: string }[]): void {
  const unfinished = subtasks.filter((s) => s.status !== "DONE").map((s) => s.title);
  if (unfinished.length > 0) {
    throw conflict(
      "SUBTASKS_NOT_DONE",
      `'${task.title}' cannot be Done: ${unfinished.length} subtask(s) not Done (${unfinished.join(", ")}).`,
      { unfinished },
    );
  }
}

// Reopen walk: the Done ancestors to move back to In Progress when a task leaves Done.
// Stops at the first ancestor that is not Done, because nothing above it can be Done.
export function ancestorsToReopen(
  startParentId: string | null,
  byId: Map<string, { id: string; parent_id: string | null; status: string }>,
): string[] {
  const ids: string[] = [];
  let current = startParentId ? byId.get(startParentId) : undefined;
  while (current && current.status === "DONE") {
    ids.push(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return ids;
}

// Skill edit vs assignee: an unqualified assignee is never kept. With the flag the assignee is cleared;
// without it the edit is rejected, so no assignment is lost unseen. The flag is ignored when they qualify.
export function checkSkillEdit(
  newSkills: NamedRef[],
  assignee: { id: string; name: string; skillIds: Set<string> } | undefined,
  unassignIfUnqualified: boolean,
): { clearAssignee: boolean } {
  if (!assignee) return { clearAssignee: false };
  const missing = missingSkills(newSkills, assignee.skillIds);
  if (missing.length === 0) return { clearAssignee: false };
  if (unassignIfUnqualified) return { clearAssignee: true };
  throw conflict(
    "SKILL_EDIT_BREAKS_ASSIGNMENT",
    `${assignee.name} lacks ${missing.join(", ")}. Confirm to save and unassign ${assignee.name}.`,
    { assignee: { id: assignee.id, name: assignee.name }, missingSkills: missing },
  );
}

// Counts the request tree and checks its depth before zod parses it, so the cheap checks reject first.
// Depth is 1-based; descent stops past maxDepth, so a deeply nested body cannot recurse far.
export function checkRawTree(body: unknown, limits: { maxDepth: number; maxTreeSize: number }): void {
  let count = 0;
  const walk = (node: unknown, depth: number, path: number[]): void => {
    if (typeof node !== "object" || node === null) return;
    if (depth > limits.maxDepth) {
      throw badRequest("NESTING_TOO_DEEP", `Tasks can be nested at most ${limits.maxDepth} levels deep.`, { path });
    }
    count += 1;
    if (count > limits.maxTreeSize) {
      throw badRequest("TREE_TOO_LARGE", `One tree can hold at most ${limits.maxTreeSize} tasks.`);
    }
    const subtasks = (node as { subtasks?: unknown }).subtasks;
    if (Array.isArray(subtasks)) subtasks.forEach((child, i) => walk(child, depth + 1, [...path, i]));
  };
  walk(body, 1, []);
}
