import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import type { Developer } from "../../api/types";
import { flushAsync, frontend, makeTask, testQueryClient } from "../../test/fixtures";
import { TaskRow } from "./TaskRow";
import type { TaskListContext } from "./taskListContext";

// The API client is stubbed, so no test here reaches the network. RequestError stays the real class.
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  setStatus: vi.fn(),
  setAssignee: vi.fn(),
}));

const setStatus = vi.mocked(client.setStatus);
const setAssignee = vi.mocked(client.setAssignee);

const alice: Developer = { id: "d-alice", name: "Alice", skills: [frontend] };

const context: TaskListContext = {
  developers: [alice],
  statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"],
  collapsed: new Set(),
  toggle: vi.fn(),
  highlighted: new Set(),
  highlightRootId: undefined,
  onHighlightEnd: vi.fn(),
  rowErrors: new Map(),
  onRowError: vi.fn(),
  onChangeStart: vi.fn(),
  onReopened: vi.fn(),
  onUnexpected: vi.fn(),
};

const parent = makeTask({
  title: "Profile update",
  status: "IN_PROGRESS",
  subtasks: [makeTask({ id: "t2", title: "Profile API", depth: 2, parentId: "t1" })],
});

function renderRow(rowErrors: ReadonlyMap<string, string> = new Map()) {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <table>
        <tbody>
          <TaskRow task={parent} context={{ ...context, rowErrors }} />
        </tbody>
      </table>
    </QueryClientProvider>,
  );
}

const statusSelect = () => screen.getByLabelText<HTMLSelectElement>("Status of Profile update");
const assigneeSelect = () => screen.getByLabelText<HTMLSelectElement>("Assignee of Profile update");
const neverSettles = () => new Promise<never>(() => {});

beforeEach(() => vi.clearAllMocks());

describe("TaskRow status change", () => {
  it("offers Done even though a subtask is unfinished", () => {
    renderRow();
    const done = screen.getAllByRole("option", { name: "Done" })[0] as HTMLOptionElement;
    expect(done.disabled).toBe(false);
  });

  it("shows the row error the page holds, under the row", () => {
    renderRow(new Map([["t1", "Profile update can't be Done."]]));
    expect(screen.getByRole("alert").textContent).toBe("Profile update can't be Done.");
  });

  it("hands the backend's message to the page and shows the old status after SUBTASKS_NOT_DONE", async () => {
    const message = "Profile update can't be Done: Profile API is not Done.";
    setStatus.mockRejectedValueOnce(
      new client.RequestError(409, "SUBTASKS_NOT_DONE", message, undefined, "req-2"),
    );
    renderRow();

    fireEvent.change(statusSelect(), { target: { value: "DONE" } });

    expect(context.onRowError).toHaveBeenCalledWith("t1", null); // the next change clears the old error
    await waitFor(() => expect(context.onRowError).toHaveBeenCalledWith("t1", message));
    await waitFor(() => expect(statusSelect().value).toBe("IN_PROGRESS"));
    expect(context.onUnexpected).not.toHaveBeenCalled();
  });

  it("sends a 500 to the page banner, not the row", async () => {
    setStatus.mockRejectedValueOnce(
      new client.RequestError(500, "INTERNAL_ERROR", "Something went wrong.", undefined, "req-3"),
    );
    renderRow();

    fireEvent.change(statusSelect(), { target: { value: "BLOCKED" } });

    await waitFor(() => expect(context.onUnexpected).toHaveBeenCalledTimes(1));
    expect(context.onRowError).not.toHaveBeenCalledWith("t1", expect.any(String));
    expect(statusSelect().value).toBe("IN_PROGRESS");
  });

  it("reports the reopened tasks on success", async () => {
    const reopened = [{ id: "t9", title: "Epic", status: "IN_PROGRESS" as const }];
    setStatus.mockResolvedValueOnce({ task: parent, reopened });
    renderRow();

    fireEvent.change(statusSelect(), { target: { value: "TODO" } });

    await waitFor(() => expect(context.onReopened).toHaveBeenCalledWith(reopened));
  });

  it("shows the picked status while saving, keeps focus, and ignores further input", async () => {
    setStatus.mockReturnValueOnce(neverSettles());
    renderRow();
    statusSelect().focus();

    fireEvent.change(statusSelect(), { target: { value: "BLOCKED" } });

    await waitFor(() => expect(statusSelect().getAttribute("aria-disabled")).toBe("true"));
    expect(statusSelect().value).toBe("BLOCKED"); // not the saved IN_PROGRESS
    expect(statusSelect().disabled).toBe(false);
    expect(document.activeElement).toBe(statusSelect());

    fireEvent.change(statusSelect(), { target: { value: "DONE" } });
    await flushAsync();
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
});

describe("TaskRow assignee change", () => {
  const unassigned = makeTask({ title: "Profile update", skills: [frontend] });

  function renderUnassignedRow() {
    render(
      <QueryClientProvider client={testQueryClient()}>
        <table>
          <tbody>
            <TaskRow task={unassigned} context={context} />
          </tbody>
        </table>
      </QueryClientProvider>,
    );
  }

  it("is disabled, showing the current assignee, until the developer list loads", () => {
    const assigned = makeTask({ title: "Profile update", assignee: { id: alice.id, name: "Alice" } });
    render(
      <QueryClientProvider client={testQueryClient()}>
        <table>
          <tbody>
            <TaskRow task={assigned} context={{ ...context, developers: undefined }} />
          </tbody>
        </table>
      </QueryClientProvider>,
    );
    expect(assigneeSelect().disabled).toBe(true);
    expect(assigneeSelect().selectedOptions[0]?.text).toBe("Alice");
  });

  it("lists only qualifying developers", () => {
    renderUnassignedRow();
    const names = Array.from(assigneeSelect().options).map((option) => option.text);
    expect(names).toEqual(["Unassigned", "Alice"]);
  });

  it("hands a refused assignment to the page and reverts the select", async () => {
    const message = "Alice cannot take 'Profile update'.";
    setAssignee.mockRejectedValueOnce(
      new client.RequestError(409, "ASSIGNEE_LACKS_SKILLS", message, undefined, "req-4"),
    );
    renderUnassignedRow();

    fireEvent.change(assigneeSelect(), { target: { value: alice.id } });

    await waitFor(() => expect(context.onRowError).toHaveBeenCalledWith("t1", message));
    await waitFor(() => expect(assigneeSelect().value).toBe(""));
    expect(setAssignee).toHaveBeenCalledWith("t1", alice.id);
  });

  it("sends a 500 to the page banner and reverts the select", async () => {
    setAssignee.mockRejectedValueOnce(
      new client.RequestError(500, "INTERNAL_ERROR", "Something went wrong.", undefined, "req-5"),
    );
    renderUnassignedRow();

    fireEvent.change(assigneeSelect(), { target: { value: alice.id } });

    await waitFor(() => expect(context.onUnexpected).toHaveBeenCalledTimes(1));
    expect(context.onRowError).not.toHaveBeenCalledWith("t1", expect.any(String));
    expect(assigneeSelect().value).toBe("");
  });

  it("shows the picked developer while saving, keeps focus, and ignores further input", async () => {
    setAssignee.mockReturnValueOnce(neverSettles());
    renderUnassignedRow();
    assigneeSelect().focus();

    fireEvent.change(assigneeSelect(), { target: { value: alice.id } });

    await waitFor(() => expect(assigneeSelect().getAttribute("aria-disabled")).toBe("true"));
    expect(assigneeSelect().value).toBe(alice.id);
    expect(assigneeSelect().disabled).toBe(false);
    expect(document.activeElement).toBe(assigneeSelect());

    fireEvent.change(assigneeSelect(), { target: { value: "" } });
    await flushAsync();
    expect(setAssignee).toHaveBeenCalledTimes(1);
  });
});
