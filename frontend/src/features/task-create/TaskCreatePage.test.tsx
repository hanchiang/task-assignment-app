import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, Outlet, RouterProvider, createMemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import { createQueryClient } from "../../api/queries";
import { backend, deferred, flushAsync, frontend, makeTask } from "../../test/fixtures";
import type { TaskNode } from "../../api/types";
import { TaskCreatePage } from "./TaskCreatePage";

// The API client is stubbed, so no test here reaches the network. RequestError stays the real class.
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  getMeta: vi.fn(),
  getDevelopers: vi.fn(),
  getSkills: vi.fn(),
  createTask: vi.fn(),
}));

const createTask = vi.mocked(client.createTask);

// Like the app's header: a link that is present on every page.
function Layout() {
  return (
    <>
      <Link to="/">Tasks</Link>
      <Outlet />
    </>
  );
}

function ListPage() {
  return (
    <>
      <p>Task list page</p>
      <pre data-testid="list-state">{JSON.stringify(useLocation().state)}</pre>
    </>
  );
}

// A data router, because useBlocker (used by the page) does not work under MemoryRouter.
function renderPage() {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: "/", element: <ListPage /> },
          { path: "/tasks/new", element: <TaskCreatePage /> },
        ],
      },
    ],
    { initialEntries: ["/tasks/new"] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const save = () => screen.getByRole("button", { name: /^Save|^Saving/ }) as HTMLButtonElement;
const titleInputs = () => screen.getAllByLabelText<HTMLInputElement>("Title");
const typeTitle = (index: number, title: string) =>
  fireEvent.change(titleInputs()[index] as HTMLInputElement, { target: { value: title } });
const group = (name: string) => screen.getByRole("group", { name });
const addSubtaskIn = (name: string) =>
  fireEvent.click(within(group(name)).getAllByText("Add Subtask")[0] as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.getMeta).mockResolvedValue({
    maxDepth: 3,
    maxTreeSize: 50,
    statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"],
  });
  vi.mocked(client.getDevelopers).mockResolvedValue([
    { id: "d-alice", name: "Alice", skills: [frontend] },
    { id: "d-carol", name: "Carol", skills: [frontend, backend] },
  ]);
  vi.mocked(client.getSkills).mockResolvedValue([backend, frontend]);
});

afterEach(() => vi.restoreAllMocks());

describe("TaskCreatePage", () => {
  it("enables Save only once every title is filled in", async () => {
    renderPage();
    await screen.findByText("Add Subtask");
    expect(save().disabled).toBe(true);

    typeTitle(0, "Profile update");
    await waitFor(() => expect(save().disabled).toBe(false));

    fireEvent.click(screen.getByText("Add Subtask"));
    expect(save().disabled).toBe(true);
  });

  it("stops offering Add Subtask on the third level", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Add Subtask"));
    fireEvent.click(screen.getAllByText("Add Subtask")[1] as HTMLElement);
    expect(titleInputs()).toHaveLength(3);
    expect(screen.getAllByText("Add Subtask")).toHaveLength(2);
  });

  it("lists only developers who have every picked skill", async () => {
    renderPage();
    await screen.findByText("Add Subtask");
    fireEvent.click(await screen.findByLabelText("Backend"));
    const assignee = within(group("Task 1")).getByLabelText("Assignee");
    const names = Array.from(assignee.querySelectorAll("option")).map((o) => o.textContent);
    expect(names).toEqual(["Unassigned", "Carol"]);
  });

  it("keeps the draft, shows the message and outlines the node a failed Save names", async () => {
    createTask.mockRejectedValueOnce(
      new client.RequestError(400, "VALIDATION_ERROR", "Title is too long.", { path: [0] }, "req-1"),
    );
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");
    fireEvent.click(screen.getByText("Add Subtask"));
    typeTitle(1, "Avatar UI");

    fireEvent.click(save());

    expect(await screen.findByText("Title is too long.")).toBeTruthy();
    expect(titleInputs().map((input) => input.value)).toEqual(["Profile update", "Avatar UI"]);
    const outlined = document.querySelectorAll(".has-error");
    expect(outlined).toHaveLength(1);
    expect(outlined[0]?.contains(titleInputs()[1] as HTMLElement)).toBe(true);
  });

  it("goes to the Task List after a successful Save", async () => {
    createTask.mockResolvedValueOnce(makeTask());
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");

    fireEvent.click(save());

    expect(await screen.findByText("Task list page")).toBeTruthy();
    expect(createTask).toHaveBeenCalledWith({ title: "Profile update" });
    expect(screen.getByTestId("list-state").textContent).toBe('{"highlightId":"t1"}');
  });

  it("refuses to be left mid-Save, and still goes to the list with the highlight on success", async () => {
    const request = deferred<TaskNode>();
    createTask.mockReturnValueOnce(request.promise);
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");
    fireEvent.click(save());
    await waitFor(() => expect(save().getAttribute("aria-disabled")).toBe("true"));

    fireEvent.click(screen.getByRole("link", { name: "Tasks" })); // the header link
    await flushAsync();
    expect(screen.queryByText("Task list page")).toBeNull();
    expect(titleInputs()[0]?.value).toBe("Profile update");

    await act(async () => request.resolve(makeTask({ id: "new1" })));

    expect(await screen.findByText("Task list page")).toBeTruthy();
    expect(screen.getByTestId("list-state").textContent).toBe('{"highlightId":"new1"}');
  });

  it("keeps the draft and shows the failure when the page was left mid-Save", async () => {
    const request = deferred<TaskNode>();
    createTask.mockReturnValueOnce(request.promise);
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");
    fireEvent.click(save());
    await waitFor(() => expect(save().getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(screen.getByRole("link", { name: "Tasks" }));

    await act(async () =>
      request.reject(new client.RequestError(400, "VALIDATION_ERROR", "Bad title.", undefined, "r")),
    );

    expect(await screen.findByText("Bad title.")).toBeTruthy();
    expect(titleInputs()[0]?.value).toBe("Profile update");
  });

  it("keeps the outline on the failed node when an earlier sibling is removed", async () => {
    createTask.mockRejectedValueOnce(
      new client.RequestError(400, "VALIDATION_ERROR", "Bad node.", { path: [0, 1] }, "req-2"),
    );
    renderPage();
    await screen.findByText("Add Subtask");
    addSubtaskIn("Task 1");
    addSubtaskIn("Subtask 1.1");
    addSubtaskIn("Subtask 1.1");
    [0, 1, 2, 3].forEach((index) => typeTitle(index, ["Root", "Parent", "First", "Second"][index] ?? ""));

    fireEvent.click(save());
    await screen.findByText("Bad node.");
    const failed = group("Subtask 1.1.2");
    expect(failed.classList.contains("has-error")).toBe(true);
    expect(within(failed).getByLabelText<HTMLInputElement>("Title").value).toBe("Second");

    fireEvent.click(within(group("Subtask 1.1.1")).getByLabelText("Remove subtask"));

    const moved = group("Subtask 1.1.1"); // "Second" is now the first child
    expect(within(moved).getByLabelText<HTMLInputElement>("Title").value).toBe("Second");
    expect(moved.classList.contains("has-error")).toBe(true);
    expect(document.querySelectorAll(".has-error")).toHaveLength(1);
  });

  it("focuses the failing node's title after a failed Save", async () => {
    createTask.mockRejectedValueOnce(
      new client.RequestError(400, "VALIDATION_ERROR", "Bad node.", { path: [0] }, "req-3"),
    );
    renderPage();
    await screen.findByText("Add Subtask");
    addSubtaskIn("Task 1");
    typeTitle(0, "Root");
    typeTitle(1, "Child");
    (document.activeElement as HTMLElement).blur();

    fireEvent.click(save());
    await screen.findByText("Bad node.");

    const childTitle = within(group("Subtask 1.1")).getByLabelText("Title");
    await waitFor(() => expect(document.activeElement).toBe(childTitle));
  });

  it("names each node's group, so repeated controls have context", async () => {
    renderPage();
    await screen.findByText("Add Subtask");
    addSubtaskIn("Task 1");
    addSubtaskIn("Subtask 1.1");
    const names = screen.getAllByRole("group").map((node) => node.getAttribute("aria-label"));
    expect(names.filter((name) => name !== null)).toEqual(["Task 1", "Subtask 1.1", "Subtask 1.1.1"]);
  });

  it("keeps Save focusable and inert while saving, so a second click sends nothing", async () => {
    createTask.mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");
    fireEvent.click(save());

    await waitFor(() => expect(save().getAttribute("aria-disabled")).toBe("true"));
    expect(save().disabled).toBe(false);
    expect(save().textContent).toBe("Saving — identifying skills…");
    fireEvent.click(save());
    await flushAsync();

    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("scrolls to and refocuses the failing node on every failed Save", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    createTask.mockRejectedValue(
      new client.RequestError(400, "VALIDATION_ERROR", "Bad node.", { path: [0] }, "req-4"),
    );
    renderPage();
    await screen.findByText("Add Subtask");
    addSubtaskIn("Task 1");
    typeTitle(0, "Root");
    typeTitle(1, "Child");
    const childTitle = () => within(group("Subtask 1.1")).getByLabelText("Title");

    for (const attempt of [1, 2]) {
      (document.activeElement as HTMLElement).blur();
      fireEvent.click(save());
      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(document.activeElement).toBe(childTitle()));
      expect(scroll.mock.contexts.at(-1)).toBe(group("Subtask 1.1"));
    }
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("keeps Add Subtask inert once the tree is full; the new node takes the focus", async () => {
    vi.mocked(client.getMeta).mockResolvedValue({ maxDepth: 3, maxTreeSize: 2, statuses: [] });
    renderPage();
    fireEvent.click(await screen.findByText("Add Subtask"));

    expect(titleInputs()).toHaveLength(2);
    expect(screen.getAllByText("Limit of 2 tasks reached").length).toBeGreaterThan(0);
    const addButton = within(group("Task 1")).getAllByText("Add Subtask")[0] as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    expect(addButton.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(titleInputs()[1]);
    fireEvent.click(addButton);
    expect(titleInputs()).toHaveLength(2);
  });

  it("leaves on Cancel without asking, even with a typed draft", async () => {
    const ask = vi.spyOn(window, "confirm");
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");

    fireEvent.click(screen.getByRole("link", { name: "Cancel" }));

    expect(await screen.findByText("Task list page")).toBeTruthy();
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps Cancel focusable and inert while a Save is in flight", async () => {
    createTask.mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    await screen.findByText("Add Subtask");
    typeTitle(0, "Profile update");
    fireEvent.click(save());
    const cancel = screen.getByRole("link", { name: "Cancel" });
    cancel.focus();

    await waitFor(() => expect(cancel.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(cancel);

    expect(screen.queryByText("Task list page")).toBeNull();
    expect(screen.getByRole("heading", { name: "Create Task(s)" })).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
  });
});
