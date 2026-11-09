import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import type { Developer, StatusChange, TaskNode } from "../../api/types";
import { backend, deferred, frontend, makeTask, testQueryClient } from "../../test/fixtures";
import { TaskListPage } from "./TaskListPage";

// The API client is stubbed, so no test here reaches the network. RequestError stays the real class.
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  getTasks: vi.fn(),
  getMeta: vi.fn(),
  getDevelopers: vi.fn(),
  getSkills: vi.fn(),
  setStatus: vi.fn(),
  setAssignee: vi.fn(),
  setSkills: vi.fn(),
}));

const getTasks = vi.mocked(client.getTasks);
const setStatus = vi.mocked(client.setStatus);
const setAssignee = vi.mocked(client.setAssignee);

const alice: Developer = { id: "d-alice", name: "Alice", skills: [frontend] };
const subtaskA = makeTask({ id: "a1", title: "Task A1", depth: 2, parentId: "a" });
const taskA = makeTask({ id: "a", title: "Task A", subtasks: [subtaskA] });
const taskB = makeTask({ id: "b", title: "Task B" });
const tasks: TaskNode[] = [taskA, taskB];

const serverError = () =>
  new client.RequestError(500, "INTERNAL_ERROR", "Something went wrong.", undefined, "req-9");

function LocationState() {
  return <pre data-testid="location-state">{JSON.stringify(useLocation().state)}</pre>;
}

function renderPage(state?: unknown) {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[{ pathname: "/", state }]}>
        <TaskListPage />
        <LocationState />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const statusOf = (title: string) => screen.getByLabelText<HTMLSelectElement>(`Status of ${title}`);
const assigneeOf = (title: string) => screen.getByLabelText<HTMLSelectElement>(`Assignee of ${title}`);
const highlightedRows = () => document.querySelectorAll(".is-highlighted");

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.getSkills).mockResolvedValue([backend, frontend]);
  getTasks.mockResolvedValue(tasks);
  vi.mocked(client.getMeta).mockResolvedValue({
    maxDepth: 3,
    maxTreeSize: 50,
    statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"],
  });
  vi.mocked(client.getDevelopers).mockResolvedValue([alice]);
});

describe("page states", () => {
  it("shows Loading while the tasks load", () => {
    getTasks.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
  });

  it("shows the empty state with a link to Create Task", async () => {
    getTasks.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No tasks yet\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a task" }).getAttribute("href")).toBe("/tasks/new");
  });

  it("shows a failed load with Retry, and the table once Retry works", async () => {
    getTasks.mockRejectedValueOnce(serverError());
    renderPage();
    expect(await screen.findByText(/Couldn't load the task list\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByLabelText("Status of Task A")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("names what failed when it was not the tasks", async () => {
    vi.mocked(client.getMeta).mockRejectedValueOnce(serverError());
    vi.mocked(client.getDevelopers).mockRejectedValueOnce(serverError());
    renderPage();
    expect(await screen.findByText(/Couldn't load the statuses and the developer list\./)).toBeTruthy();
  });

  it("keeps the rows and says the list may be stale when a refetch fails", async () => {
    setStatus.mockResolvedValueOnce({ task: taskB, reopened: [] });
    renderPage();
    await screen.findByLabelText("Status of Task B");
    getTasks.mockRejectedValueOnce(serverError());

    fireEvent.change(statusOf("Task B"), { target: { value: "BLOCKED" } });

    const notice = await screen.findByText(/Couldn't refresh tasks; the list may be out of date\./);
    expect(statusOf("Task A")).toBeTruthy(); // the rows are still there
    fireEvent.click(within(notice.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh tasks/)).toBeNull());
  });
});

describe("banners", () => {
  it("shows the error and reopened banners separately, and clears both on the next change", async () => {
    const reopened = [{ id: "x", title: "Epic", status: "IN_PROGRESS" as const }];
    const slowChange = deferred<StatusChange>();
    setStatus.mockReturnValueOnce(slowChange.promise).mockResolvedValueOnce({ task: taskB, reopened: [] });
    setAssignee.mockRejectedValueOnce(serverError());
    renderPage();
    await screen.findByLabelText("Status of Task A");

    fireEvent.change(statusOf("Task A"), { target: { value: "TODO" } }); // stays in flight
    fireEvent.change(assigneeOf("Task B"), { target: { value: alice.id } }); // fails
    const error = await screen.findByRole("alert");
    await act(async () => slowChange.resolve({ task: taskA, reopened })); // reopens Epic

    const info = await screen.findByRole("status");
    expect(error.textContent).toContain("Something went wrong (request id req-9).");
    expect(info.textContent).toContain("Epic moved back to In Progress.");

    fireEvent.change(statusOf("Task B"), { target: { value: "BLOCKED" } });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a fresh reopened banner when another change finishes with nothing reopened", async () => {
    const slowChange = deferred<StatusChange>();
    const reopened = [{ id: "x", title: "Epic", status: "IN_PROGRESS" as const }];
    setStatus
      .mockReturnValueOnce(slowChange.promise) // Task A: still saving
      .mockResolvedValueOnce({ task: taskB, reopened }); // Task B: reopens Epic
    renderPage();
    await screen.findByLabelText("Status of Task A");

    fireEvent.change(statusOf("Task A"), { target: { value: "TODO" } });
    fireEvent.change(statusOf("Task B"), { target: { value: "BLOCKED" } });
    expect((await screen.findByRole("status")).textContent).toContain("Epic moved back");
    await act(async () => slowChange.resolve({ task: taskA, reopened: [] }));

    expect(screen.getByRole("status").textContent).toContain("Epic moved back");
  });

  it("dismisses a banner with its ×", async () => {
    setAssignee.mockRejectedValueOnce(serverError());
    renderPage();
    await screen.findByLabelText("Status of Task B");

    fireEvent.change(assigneeOf("Task B"), { target: { value: alice.id } });
    const banner = await screen.findByRole("alert");
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("highlight of a new tree", () => {
  it("highlights the new tree, clears the router state, and stops after the animation", async () => {
    renderPage({ highlightId: "a" });
    await screen.findByLabelText("Status of Task A");

    expect(highlightedRows()).toHaveLength(2); // Task A and its subtask, not Task B
    await waitFor(() => expect(screen.getByTestId("location-state").textContent).toBe("null"));

    const rootRow = screen.getByLabelText("Status of Task A").closest("tr") as HTMLElement;
    fireEvent.animationEnd(rootRow);

    expect(highlightedRows()).toHaveLength(0);
  });

  it("scrolls the new tree's top-level row into view, once", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderPage({ highlightId: "a" });
    await screen.findByLabelText("Status of Task A");

    const rootRow = screen.getByLabelText("Status of Task A").closest("tr");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(rootRow);
  });

  it("highlights nothing, and scrolls nowhere, without router state", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderPage();
    await screen.findByLabelText("Status of Task A");
    expect(scroll).not.toHaveBeenCalled();
    expect(highlightedRows()).toHaveLength(0);
  });
});

describe("row outcomes survive the row", () => {
  it("shows a failed save's error after its parent was collapsed and expanded again", async () => {
    const message = "Task A1 can't be Done: Task A2 is not Done.";
    const slowChange = deferred<StatusChange>();
    setStatus.mockReturnValueOnce(slowChange.promise);
    renderPage();
    await screen.findByLabelText("Status of Task A1");

    fireEvent.change(statusOf("Task A1"), { target: { value: "DONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Task A" })); // unmounts Task A1's row
    expect(screen.queryByLabelText("Status of Task A1")).toBeNull();
    await act(async () =>
      slowChange.reject(new client.RequestError(409, "SUBTASKS_NOT_DONE", message, undefined, "r")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Task A" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(statusOf("Task A1").value).toBe("TODO");
  });
});

describe("skill editor from the list", () => {
  it("returns focus to the same button after Pick skills, though the row becomes a USER row", async () => {
    const failedTask = makeTask({ id: "b", title: "Task B", skills: [], skillSource: "FAILED" });
    const savedTask = makeTask({ id: "b", title: "Task B", skills: [frontend], skillSource: "USER" });
    getTasks.mockResolvedValueOnce([failedTask]).mockResolvedValue([savedTask]);
    vi.mocked(client.setSkills).mockResolvedValueOnce(savedTask);
    renderPage();
    const pick = await screen.findByRole("button", { name: "Pick skills for Task B" });
    pick.focus();

    fireEvent.click(pick);
    fireEvent.click(await screen.findByLabelText("Frontend"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const edit = await screen.findByRole("button", { name: "Edit skills of Task B" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(edit).toBe(pick); // one button, so React kept it
    expect(document.activeElement).toBe(edit);
  });
});
