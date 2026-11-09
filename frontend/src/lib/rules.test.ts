import { describe, expect, it } from "vitest";
import type { Developer, Skill, Status, TaskNode } from "../api/types";
import { doneProgress, qualifies, qualifyingDevelopers } from "./rules";

const frontend: Skill = { id: "s-front", name: "Frontend" };
const backend: Skill = { id: "s-back", name: "Backend" };

const dev = (name: string, skills: Skill[]): Developer => ({ id: `d-${name}`, name, skills });
const alice = dev("Alice", [frontend]);
const bob = dev("Bob", [backend]);
const carol = dev("Carol", [frontend, backend]);

function task(title: string, status: Status, subtasks: TaskNode[] = []): TaskNode {
  return {
    id: title,
    title,
    status,
    parentId: null,
    depth: 1,
    skills: [],
    skillSource: "USER",
    assignee: null,
    subtasks,
  };
}

describe("qualifyingDevelopers", () => {
  const everyone = [alice, bob, carol];

  it("requires every task skill, not just one", () => {
    expect(qualifyingDevelopers(everyone, [frontend.id, backend.id])).toEqual([carol]);
  });

  it("lists everyone who has the single required skill", () => {
    expect(qualifyingDevelopers(everyone, [frontend.id])).toEqual([alice, carol]);
  });

  it("lists nobody for a task with no skills", () => {
    expect(qualifyingDevelopers(everyone, [])).toEqual([]);
    expect(qualifies(carol, [])).toBe(false);
  });

  it("lists nobody when no developer has the skill", () => {
    expect(qualifyingDevelopers(everyone, ["s-unknown"])).toEqual([]);
  });
});

describe("doneProgress", () => {
  it("counts direct subtasks that are Done", () => {
    const parent = task("parent", "TODO", [task("a", "DONE"), task("b", "TODO"), task("c", "DONE")]);
    expect(doneProgress(parent)).toEqual({ done: 2, total: 3 });
  });

  it("does not count grandchildren", () => {
    const parent = task("parent", "TODO", [task("a", "DONE", [task("x", "TODO"), task("y", "TODO")])]);
    expect(doneProgress(parent)).toEqual({ done: 1, total: 1 });
  });

  it("is 0 of 0 without subtasks", () => {
    expect(doneProgress(task("leaf", "TODO"))).toEqual({ done: 0, total: 0 });
  });
});
