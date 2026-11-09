// Task request shapes, validated with zod, and the response shapes they produce. See docs/design.md → API contract.
import { z } from "zod";
import type { Skill } from "../skills/repo.js";
import { Id, type IssuePath } from "../validation.js";
import { STATUSES, type SkillSource, type Status } from "./rules.js";

export type NewTask = {
  title: string;
  skillIds?: string[] | undefined;
  assigneeId?: string | undefined;
  subtasks?: NewTask[] | undefined;
};

export const NewTaskSchema: z.ZodType<NewTask> = z.object({
  title: z.string().trim().min(1).max(500),
  skillIds: z.array(Id).optional(),
  assigneeId: Id.optional(),
  get subtasks() {
    return z.array(NewTaskSchema).optional();
  },
});

// details.path for a create error: only an index right after "subtasks" names a node; an index into
// skillIds does not. Example: ["subtasks", 0, "skillIds", 1] gives { path: [0] }.
export function nodePath(path: IssuePath): { path: number[] } {
  return { path: path.flatMap((p, i) => (typeof p === "number" && path[i - 1] === "subtasks" ? [p] : [])) };
}

export const StatusBody = z.object({ status: z.enum(STATUSES) });
export const AssigneeBody = z.object({ developerId: Id.nullable() });
export const SkillsBody = z.object({
  skillIds: z.array(Id).min(1),
  unassignIfUnqualified: z.boolean().optional(),
});

export type TaskRef = { id: string; title: string; status: Status };
export type TaskNode = {
  id: string;
  title: string;
  status: Status;
  parentId: string | null;
  depth: number;
  skills: Skill[];
  skillSource: SkillSource;
  assignee: { id: string; name: string } | null;
  subtasks: TaskNode[];
};
export type StatusChange = { task: TaskNode; reopened: TaskRef[] };
