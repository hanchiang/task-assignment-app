// The creation form's state: one tree of nodes and a pure reducer over it. A node is addressed by
// its path, the indexes into `subtasks` from the top-level task, which is also how the backend
// reports which node an error is about (details.path). The top-level node has the path [].
import type { Developer, Id, Meta, NewTask, NodePath } from "../../api/types";
import { qualifies } from "../../lib/rules";

export type DraftNode = {
  key: string; // stable React key, so removing a node does not shift the others' input state
  title: string;
  skillIds: Id[];
  assigneeId: Id | null;
  subtasks: DraftNode[];
};

export type Path = number[];
export type Limits = Pick<Meta, "maxDepth" | "maxTreeSize">;

export type DraftAction =
  | { type: "add_subtask"; path: Path; key: string; limits: Limits }
  | { type: "remove"; path: Path }
  | { type: "set_title"; path: Path; title: string }
  // developers is needed to drop an assignee the new skills no longer qualify
  | { type: "set_skills"; path: Path; skillIds: Id[]; developers: Developer[] }
  | { type: "set_assignee"; path: Path; assigneeId: Id | null };

let keyCounter = 0;
// A counter, not crypto.randomUUID(), which browsers expose only on secure origins (https, localhost).
export const newDraftKey = (): string => `node-${++keyCounter}`;

export const newDraftNode = (key: string = newDraftKey()): DraftNode => ({
  key,
  title: "",
  skillIds: [],
  assigneeId: null,
  subtasks: [],
});

export const levelOf = (path: Path): number => path.length + 1;

// "Task 1" for the top-level task, "Subtask 1.2" and "Subtask 1.2.1" below it, the numbering the
// brief's wireframe uses. It names the node's group on the page, so its inner controls have context.
export function nodeLabel(path: Path): string {
  const numbers = ["1", ...path.map((index) => String(index + 1))];
  return `${path.length === 0 ? "Task" : "Subtask"} ${numbers.join(".")}`;
}

export function nodeAt(root: DraftNode, path: Path): DraftNode | undefined {
  const [index, ...rest] = path;
  if (index === undefined) return root;
  const child = root.subtasks[index];
  return child && nodeAt(child, rest);
}

export function countNodes(node: DraftNode): number {
  return node.subtasks.reduce((sum, child) => sum + countNodes(child), 1);
}

export function hasEmptyTitle(node: DraftNode): boolean {
  return node.title.trim() === "" || node.subtasks.some(hasEmptyTitle);
}

// A node takes a child only while its own level is below maxDepth; the size limit covers the whole tree.
export const canAddSubtaskAt = (path: Path, limits: Limits): boolean => levelOf(path) < limits.maxDepth;
export const isTreeFull = (root: DraftNode, limits: Limits): boolean =>
  countNodes(root) >= limits.maxTreeSize;

export function toNewTask(node: DraftNode): NewTask {
  const task: NewTask = { title: node.title.trim() };
  if (node.skillIds.length > 0) task.skillIds = node.skillIds;
  if (node.assigneeId !== null) task.assigneeId = node.assigneeId;
  if (node.subtasks.length > 0) task.subtasks = node.subtasks.map(toNewTask);
  return task;
}

// Returns a copy of the tree with the node at `path` replaced by change(node).
function updateAt(node: DraftNode, path: Path, change: (target: DraftNode) => DraftNode): DraftNode {
  const [index, ...rest] = path;
  if (index === undefined) return change(node);
  const subtasks = node.subtasks.map((child, i) => (i === index ? updateAt(child, rest, change) : child));
  return { ...node, subtasks };
}

function withoutNode(root: DraftNode, path: Path): DraftNode {
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  return updateAt(root, parentPath, (parent) => ({
    ...parent,
    subtasks: parent.subtasks.filter((_, i) => i !== index),
  }));
}

function withSkills(node: DraftNode, skillIds: Id[], developers: Developer[]): DraftNode {
  const assignee = developers.find((developer) => developer.id === node.assigneeId);
  const keepsAssignee = assignee !== undefined && qualifies(assignee, skillIds);
  return { ...node, skillIds, assigneeId: keepsAssignee ? node.assigneeId : null };
}

export function draftReducer(root: DraftNode, action: DraftAction): DraftNode {
  switch (action.type) {
    case "add_subtask": {
      const allowed = canAddSubtaskAt(action.path, action.limits) && !isTreeFull(root, action.limits);
      if (!allowed) return root;
      const child = newDraftNode(action.key);
      return updateAt(root, action.path, (parent) => ({ ...parent, subtasks: [...parent.subtasks, child] }));
    }
    case "remove":
      return action.path.length === 0 ? root : withoutNode(root, action.path);
    case "set_title":
      return updateAt(root, action.path, (node) => ({ ...node, title: action.title }));
    case "set_skills":
      return updateAt(root, action.path, (node) => withSkills(node, action.skillIds, action.developers));
    case "set_assignee":
      return updateAt(root, action.path, (node) => ({ ...node, assigneeId: action.assigneeId }));
  }
}

// details.path of a create error, if the backend sent one in the expected shape.
export function readNodePath(details: unknown): Path | null {
  const path = (details as Partial<NodePath> | null | undefined)?.path;
  const valid = Array.isArray(path) && path.every((index) => Number.isInteger(index));
  return valid ? path : null;
}
