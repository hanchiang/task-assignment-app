// The API's wire shapes, copied from docs/design.md → API contract. Status values are the wire
// values (TODO, IN_PROGRESS, ...), not the labels the UI shows.
export type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type SkillSource = "USER" | "LLM" | "FAILED";
export type Id = string;

export type Skill = { id: Id; name: string };
export type Developer = { id: Id; name: string; skills: Skill[] };
export type TaskRef = { id: Id; title: string; status: Status };

export type TaskNode = {
  id: Id;
  title: string;
  status: Status;
  parentId: Id | null;
  depth: number;
  skills: Skill[];
  skillSource: SkillSource;
  assignee: { id: Id; name: string } | null;
  subtasks: TaskNode[];
};

export type StatusChange = { task: TaskNode; reopened: TaskRef[] };

export type Meta = { maxDepth: number; maxTreeSize: number; statuses: Status[] };

export type NewTask = {
  title: string;
  skillIds?: Id[];
  assigneeId?: Id;
  subtasks?: NewTask[];
};

export type SkillsUpdate = { skillIds: Id[]; unassignIfUnqualified?: true };

export type ErrorBody = {
  error: { code: string; message: string; requestId: string; details?: unknown };
};

// details of a SKILL_EDIT_BREAKS_ASSIGNMENT error
export type SkillEditConflict = { assignee: { id: Id; name: string }; missingSkills: string[] };

// details of a create error about one node: indexes into `subtasks`, from the top-level task
export type NodePath = { path: number[] };
