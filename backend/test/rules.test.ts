import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import {
  ancestorsToReopen,
  checkAssignment,
  checkCanBeDone,
  checkRawTree,
  checkSkillEdit,
} from "../src/tasks/rules.js";

const FE = { id: "fe", name: "Frontend" };
const BE = { id: "be", name: "Backend" };
const limits = { maxDepth: 3, maxTreeSize: 50 };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as AppError).code;
  }
  return undefined;
}

describe("assignment rule", () => {
  it("accepts a developer with every required skill", () => {
    expect(codeOf(() => checkAssignment({ title: "t", skills: [FE, BE] }, { name: "Carol", skillIds: new Set(["fe", "be"]) }))).toBeUndefined();
  });

  it("rejects a developer missing one of several skills", () => {
    expect(codeOf(() => checkAssignment({ title: "t", skills: [FE, BE] }, { name: "Alice", skillIds: new Set(["fe"]) }))).toBe(
      "ASSIGNEE_LACKS_SKILLS",
    );
  });

  it("rejects assigning a task with no skills", () => {
    expect(codeOf(() => checkAssignment({ title: "t", skills: [] }, { name: "Carol", skillIds: new Set(["fe", "be"]) }))).toBe(
      "TASK_HAS_NO_SKILLS",
    );
  });

  it("names the rule and the missing skill in the message", () => {
    try {
      checkAssignment({ title: "Avatar UI", skills: [FE] }, { name: "Bob", skillIds: new Set(["be"]) });
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).message).toBe("Bob cannot take 'Avatar UI': it requires Frontend, and Bob lacks Frontend.");
    }
  });
});

describe("Done rule", () => {
  it("allows Done when every direct subtask is Done, or there are none", () => {
    expect(codeOf(() => checkCanBeDone({ title: "p" }, [{ title: "a", status: "DONE" }]))).toBeUndefined();
    expect(codeOf(() => checkCanBeDone({ title: "p" }, []))).toBeUndefined();
  });

  it("rejects Done while any direct subtask is not Done, naming it", () => {
    try {
      checkCanBeDone({ title: "p" }, [{ title: "a", status: "DONE" }, { title: "b", status: "BLOCKED" }]);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).code).toBe("SUBTASKS_NOT_DONE");
      expect((err as AppError).details).toEqual({ unfinished: ["b"] });
    }
  });
});

describe("reopen walk", () => {
  const tree = (statuses: [string, string | null, string][]) =>
    new Map(statuses.map(([id, parent_id, status]) => [id, { id, parent_id, status }]));

  it("resets every Done ancestor up to the root", () => {
    const t = tree([["a", null, "DONE"], ["b", "a", "DONE"], ["c", "b", "DONE"]]);
    expect(ancestorsToReopen("b", t)).toEqual(["b", "a"]);
  });

  it("stops at the first ancestor that is not Done", () => {
    const t = tree([["a", null, "DONE"], ["b", "a", "IN_PROGRESS"], ["c", "b", "DONE"]]);
    expect(ancestorsToReopen("b", t)).toEqual([]);
  });

  it("returns nothing for a top-level task", () => {
    expect(ancestorsToReopen(null, tree([["a", null, "DONE"]]))).toEqual([]);
  });
});

describe("skill edit vs assignee", () => {
  const alice = { id: "alice", name: "Alice", skillIds: new Set(["fe"]) };

  it("rejects an edit the assignee no longer qualifies for, without the flag", () => {
    try {
      checkSkillEdit([FE, BE], alice, false);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).code).toBe("SKILL_EDIT_BREAKS_ASSIGNMENT");
      expect((err as AppError).details).toEqual({ assignee: { id: "alice", name: "Alice" }, missingSkills: ["Backend"] });
    }
  });

  it("clears the assignee with the flag", () => {
    expect(checkSkillEdit([FE, BE], alice, true)).toEqual({ clearAssignee: true });
  });

  it("keeps a qualifying assignee, with or without the flag", () => {
    expect(checkSkillEdit([FE], alice, true)).toEqual({ clearAssignee: false });
    expect(checkSkillEdit([FE], alice, false)).toEqual({ clearAssignee: false });
  });

  it("passes when there is no assignee", () => {
    expect(checkSkillEdit([BE], undefined, false)).toEqual({ clearAssignee: false });
  });
});

describe("tree limits", () => {
  const chain = (levels: number): unknown => (levels === 1 ? { title: "x" } : { title: "x", subtasks: [chain(levels - 1)] });

  it("accepts 3 levels and rejects 4", () => {
    expect(codeOf(() => checkRawTree(chain(3), limits))).toBeUndefined();
    expect(codeOf(() => checkRawTree(chain(4), limits))).toBe("NESTING_TOO_DEEP");
  });

  it("reports the path of the node that is too deep", () => {
    const body = { title: "a", subtasks: [{ title: "b" }, { title: "c", subtasks: [{ title: "d", subtasks: [{ title: "e" }] }] }] };
    try {
      checkRawTree(body, limits);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).details).toEqual({ path: [1, 0, 0] });
    }
  });

  it("accepts 50 tasks and rejects 51", () => {
    const tree = (n: number) => ({ title: "root", subtasks: Array.from({ length: n - 1 }, () => ({ title: "s" })) });
    expect(codeOf(() => checkRawTree(tree(50), limits))).toBeUndefined();
    expect(codeOf(() => checkRawTree(tree(51), limits))).toBe("TREE_TOO_LARGE");
  });
});
