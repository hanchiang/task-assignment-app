import { describe, expect, it } from "vitest";
import type { Developer, Skill } from "../../api/types";
import {
  canAddSubtaskAt,
  countNodes,
  draftReducer,
  hasEmptyTitle,
  isTreeFull,
  newDraftNode,
  nodeAt,
  nodeLabel,
  toNewTask,
  type DraftAction,
  type DraftNode,
  type Limits,
  type Path,
} from "./draft";

const limits: Limits = { maxDepth: 3, maxTreeSize: 50 };
const frontend: Skill = { id: "s-front", name: "Frontend" };
const backend: Skill = { id: "s-back", name: "Backend" };
const alice: Developer = { id: "d-alice", name: "Alice", skills: [frontend] };
const carol: Developer = { id: "d-carol", name: "Carol", skills: [frontend, backend] };
const developers = [alice, carol];

let keyCount = 0;
const nextKey = () => `test-${++keyCount}`;

function run(root: DraftNode, ...actions: DraftAction[]): DraftNode {
  return actions.reduce(draftReducer, root);
}

const addAt = (path: Path, size: Limits = limits): DraftAction => ({
  type: "add_subtask",
  path,
  key: nextKey(),
  limits: size,
});

const setSkills = (path: Path, skillIds: string[]): DraftAction => ({
  type: "set_skills",
  path,
  skillIds,
  developers,
});

const root = () => newDraftNode("root");

describe("add and remove", () => {
  it("adds a subtask, in order, under the node at the path", () => {
    const tree = run(root(), addAt([]), addAt([]), addAt([0]));
    expect(tree.subtasks).toHaveLength(2);
    expect(tree.subtasks[0]?.subtasks).toHaveLength(1);
    expect(tree.subtasks[1]?.subtasks).toHaveLength(0);
  });

  it("accepts three levels", () => {
    const tree = run(root(), addAt([]), addAt([0]));
    expect(countNodes(tree)).toBe(3);
    expect(tree.subtasks[0]?.subtasks[0]?.subtasks).toEqual([]);
  });

  it("refuses a fourth level and returns the same state", () => {
    const threeLevels = run(root(), addAt([]), addAt([0]));
    expect(draftReducer(threeLevels, addAt([0, 0]))).toBe(threeLevels);
  });

  it("follows a raised maxDepth", () => {
    const deeper: Limits = { maxDepth: 4, maxTreeSize: 50 };
    const tree = run(root(), addAt([], deeper), addAt([0], deeper), addAt([0, 0], deeper));
    expect(countNodes(tree)).toBe(4);
  });

  it("removes a subtask with everything under it", () => {
    const tree = run(root(), addAt([]), addAt([]), addAt([0]), { type: "remove", path: [0] });
    expect(countNodes(tree)).toBe(2);
  });

  it("keeps the remaining nodes' keys when one is removed", () => {
    const tree = run(root(), addAt([]), addAt([]));
    const keptKey = tree.subtasks[1]?.key;
    const after = draftReducer(tree, { type: "remove", path: [0] });
    expect(after.subtasks.map((node) => node.key)).toEqual([keptKey]);
  });

  it("never removes the top-level task", () => {
    const tree = run(root(), addAt([]));
    expect(draftReducer(tree, { type: "remove", path: [] })).toBe(tree);
  });

  it("does not mutate the previous state", () => {
    const before = run(root(), addAt([]));
    const snapshot = structuredClone(before);
    run(before, addAt([0]), { type: "set_title", path: [0], title: "x" }, { type: "remove", path: [0] });
    expect(before).toEqual(snapshot);
  });
});

describe("tree size limit", () => {
  const small: Limits = { maxDepth: 3, maxTreeSize: 3 };

  it("accepts subtasks up to maxTreeSize", () => {
    const tree = run(root(), addAt([], small), addAt([], small));
    expect(countNodes(tree)).toBe(3);
    expect(isTreeFull(tree, small)).toBe(true);
  });

  it("refuses the next one, and allows it again after a removal", () => {
    const full = run(root(), addAt([], small), addAt([], small));
    expect(draftReducer(full, addAt([0], small))).toBe(full);
    const room = draftReducer(full, { type: "remove", path: [1] });
    expect(isTreeFull(room, small)).toBe(false);
    expect(countNodes(draftReducer(room, addAt([0], small)))).toBe(3);
  });

  it("counts every level, not only direct children", () => {
    const tree = run(root(), addAt([], small), addAt([0], small));
    expect(isTreeFull(tree, small)).toBe(true);
  });
});

describe("depth limit helper", () => {
  it("offers Add Subtask on levels 1 and 2 only", () => {
    expect(canAddSubtaskAt([], limits)).toBe(true);
    expect(canAddSubtaskAt([0], limits)).toBe(true);
    expect(canAddSubtaskAt([0, 0], limits)).toBe(false);
  });
});

describe("assignee follows the skills", () => {
  const withAssignee = (skillIds: string[], assigneeId: string): DraftNode =>
    run(root(), setSkills([], skillIds), { type: "set_assignee", path: [], assigneeId });

  it("keeps an assignee who still qualifies", () => {
    const tree = run(withAssignee([frontend.id], carol.id), setSkills([], [frontend.id, backend.id]));
    expect(tree.assigneeId).toBe(carol.id);
  });

  it("clears an assignee who no longer qualifies", () => {
    const tree = run(withAssignee([frontend.id], alice.id), setSkills([], [frontend.id, backend.id]));
    expect(tree.assigneeId).toBeNull();
    expect(tree.skillIds).toEqual([frontend.id, backend.id]);
  });

  it("clears the assignee when all skills are cleared", () => {
    const tree = run(withAssignee([frontend.id], alice.id), setSkills([], []));
    expect(tree.assigneeId).toBeNull();
  });

  it("clears the assignee of a subtask without touching its parent", () => {
    const tree = run(
      root(),
      addAt([]),
      setSkills([], [frontend.id]),
      setSkills([0], [frontend.id]),
      { type: "set_assignee", path: [], assigneeId: alice.id },
      { type: "set_assignee", path: [0], assigneeId: alice.id },
      setSkills([0], []),
    );
    expect(tree.assigneeId).toBe(alice.id);
    expect(tree.subtasks[0]?.assigneeId).toBeNull();
  });
});

describe("title and request body", () => {
  it("reports an empty or blank title anywhere in the tree", () => {
    const named = run(root(), { type: "set_title", path: [], title: "Parent" }, addAt([]));
    expect(hasEmptyTitle(named)).toBe(true);
    const blank = run(named, { type: "set_title", path: [0], title: "   " });
    expect(hasEmptyTitle(blank)).toBe(true);
    const filled = run(blank, { type: "set_title", path: [0], title: "Child" });
    expect(hasEmptyTitle(filled)).toBe(false);
  });

  it("builds the API body: trimmed titles, optional fields omitted", () => {
    const tree = run(
      root(),
      { type: "set_title", path: [], title: "  Profile update " },
      setSkills([], [frontend.id]),
      { type: "set_assignee", path: [], assigneeId: alice.id },
      addAt([]),
      { type: "set_title", path: [0], title: "Avatar UI" },
    );
    expect(toNewTask(tree)).toEqual({
      title: "Profile update",
      skillIds: [frontend.id],
      assigneeId: alice.id,
      subtasks: [{ title: "Avatar UI" }],
    });
  });
});

describe("node addressing", () => {
  it("labels nodes with the wireframe's numbering", () => {
    expect(nodeLabel([])).toBe("Task 1");
    expect(nodeLabel([0])).toBe("Subtask 1.1");
    expect(nodeLabel([1])).toBe("Subtask 1.2");
    expect(nodeLabel([0, 1])).toBe("Subtask 1.1.2");
  });

  it("finds a node by path, and nothing for a path that does not exist", () => {
    const tree = run(root(), addAt([]), addAt([0]), addAt([0]));
    expect(nodeAt(tree, [])).toBe(tree);
    expect(nodeAt(tree, [0, 1])).toBe(tree.subtasks[0]?.subtasks[1]);
    expect(nodeAt(tree, [1])).toBeUndefined();
    expect(nodeAt(tree, [0, 5])).toBeUndefined();
  });
});
