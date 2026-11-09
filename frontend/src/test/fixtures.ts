import { QueryClient } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import type { Skill, TaskNode } from "../api/types";

export const frontend: Skill = { id: "s-front", name: "Frontend" };
export const backend: Skill = { id: "s-back", name: "Backend" };

export function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "t1",
    title: "Avatar UI",
    status: "TODO",
    parentId: null,
    depth: 1,
    skills: [frontend],
    skillSource: "LLM",
    assignee: null,
    subtasks: [],
    ...overrides,
  };
}

// Retries off, so a rejected read fails at once instead of after TanStack Query's back-off.
export const testQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

// A promise the test settles by hand, to hold a request in flight.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets pending promise callbacks run. A mutation starts its request after its own awaits (a tick or
// two after mutate()), so a test that asserts "nothing was sent" must wait this long first, or it
// passes even when something was.
export const flushAsync = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
