import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import { backend, flushAsync, frontend, makeTask, testQueryClient } from "../../test/fixtures";
import { SkillEditor } from "./SkillEditor";

// The API client is stubbed, so no test here reaches the network. RequestError stays the real class.
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  getSkills: vi.fn(),
  setSkills: vi.fn(),
}));

const setSkills = vi.mocked(client.setSkills);
const task = makeTask({ assignee: { id: "d-alice", name: "Alice" } });

const conflict = new client.RequestError(
  409,
  "SKILL_EDIT_BREAKS_ASSIGNMENT",
  "Alice cannot keep this task.",
  { assignee: { id: "d-alice", name: "Alice" }, missingSkills: ["Backend"] },
  "req-1",
);

function renderEditor() {
  const onClose = vi.fn();
  const onSaveStart = vi.fn();
  const queryClient = testQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SkillEditor task={task} onClose={onClose} onSaveStart={onSaveStart} />
    </QueryClientProvider>,
  );
  return { onClose, onSaveStart, queryClient };
}

// Ticks Backend (the task starts with Frontend) and presses Save.
async function saveWithBackendTicked() {
  fireEvent.click(await screen.findByLabelText("Backend"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(() => {
  vi.mocked(client.getSkills).mockResolvedValue([backend, frontend]);
  setSkills.mockReset();
});

describe("SkillEditor", () => {
  it("opens the confirm on a 409 and resends with the flag on Confirm", async () => {
    setSkills.mockRejectedValueOnce(conflict).mockResolvedValueOnce(task);
    const { onClose } = renderEditor();

    await saveWithBackendTicked();
    expect(await screen.findByText("Alice lacks Backend.")).toBeTruthy();
    expect(setSkills).toHaveBeenCalledTimes(1);
    expect(setSkills).toHaveBeenLastCalledWith("t1", { skillIds: [frontend.id, backend.id] });

    fireEvent.click(screen.getByRole("button", { name: "Save and unassign" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setSkills).toHaveBeenCalledTimes(2);
    expect(setSkills).toHaveBeenLastCalledWith("t1", {
      skillIds: [frontend.id, backend.id],
      unassignIfUnqualified: true,
    });
  });

  it("resends the skills the 409 answered, not boxes changed since", async () => {
    setSkills.mockRejectedValueOnce(conflict).mockResolvedValueOnce(task);
    const { onClose } = renderEditor();
    await saveWithBackendTicked(); // Frontend + Backend
    await screen.findByText("Alice lacks Backend.");

    fireEvent.click(screen.getByLabelText("Backend")); // unticked while the confirm is open
    fireEvent.click(screen.getByRole("button", { name: "Save and unassign" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setSkills).toHaveBeenLastCalledWith("t1", {
      skillIds: [frontend.id, backend.id],
      unassignIfUnqualified: true,
    });
  });

  it("sends nothing more on Cancel, and keeps the editor open with its draft", async () => {
    setSkills.mockRejectedValueOnce(conflict);
    const { onClose } = renderEditor();

    await saveWithBackendTicked();
    await screen.findByText("Alice lacks Backend.");
    const confirm = screen.getByRole("dialog", { name: "Change skills?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Alice lacks Backend.")).toBeNull());
    expect(setSkills).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    const backendBox = screen.getByLabelText<HTMLInputElement>("Backend");
    expect(backendBox.checked).toBe(true);
  });

  it("makes one call and closes when the assignee still qualifies", async () => {
    setSkills.mockResolvedValueOnce(task);
    const { onClose, onSaveStart } = renderEditor();

    await saveWithBackendTicked();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setSkills).toHaveBeenCalledTimes(1);
    expect(onSaveStart).toHaveBeenCalledTimes(1); // the page clears its banners once per save
  });

  it("disables Save while no skill is ticked", async () => {
    renderEditor();
    fireEvent.click(await screen.findByLabelText("Frontend"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("ignores Cancel and Esc while a save is in flight, so its result is not lost", async () => {
    setSkills.mockReturnValueOnce(new Promise(() => {}));
    const { onClose } = renderEditor();

    await saveWithBackendTicked();

    const cancel = await screen.findByRole<HTMLButtonElement>("button", { name: "Cancel" });
    await waitFor(() => expect(cancel.disabled).toBe(true));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Save focusable and inert while saving, so a second click sends nothing", async () => {
    setSkills.mockReturnValueOnce(new Promise(() => {}));
    renderEditor();
    await saveWithBackendTicked();
    const saveButton = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    saveButton.focus();

    await waitFor(() => expect(saveButton.getAttribute("aria-disabled")).toBe("true"));
    expect(saveButton.disabled).toBe(false);
    expect(document.activeElement).toBe(saveButton);
    fireEvent.click(saveButton);
    await flushAsync();

    expect(setSkills).toHaveBeenCalledTimes(1);
  });

  it("ignores Esc on the confirm while its save is in flight", async () => {
    setSkills.mockRejectedValueOnce(conflict).mockReturnValueOnce(new Promise(() => {}));
    renderEditor();
    await saveWithBackendTicked();
    const confirm = await screen.findByRole("dialog", { name: "Change skills?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Save and unassign" }));
    await waitFor(() => expect(setSkills).toHaveBeenCalledTimes(2));

    fireEvent(confirm, new Event("cancel", { cancelable: true }));

    expect(screen.getByRole("dialog", { name: "Change skills?" })).toBeTruthy();
  });

  it("saves with no change, which turns LLM skills into user skills", async () => {
    setSkills.mockResolvedValueOnce(task);
    const { onClose } = renderEditor();
    await screen.findByLabelText("Frontend");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setSkills).toHaveBeenCalledWith("t1", { skillIds: [frontend.id] });
  });

  it("announces a failed save inside the editor", async () => {
    setSkills.mockRejectedValueOnce(
      new client.RequestError(400, "VALIDATION_ERROR", "Unknown skill.", undefined, "req-7"),
    );
    renderEditor();
    await saveWithBackendTicked();
    expect((await screen.findByRole("alert")).textContent).toBe("Unknown skill.");
  });

  it("announces that the skill list could not be loaded", async () => {
    vi.mocked(client.getSkills).mockRejectedValue(new client.RequestError(500, "X", "x"));
    renderEditor();
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load skills.");
  });

  it("keeps the skill list on screen when only a later refresh of it fails", async () => {
    const { queryClient } = renderEditor();
    await screen.findByLabelText("Frontend");
    vi.mocked(client.getSkills).mockRejectedValueOnce(new client.RequestError(500, "X", "x"));

    await act(() => queryClient.invalidateQueries({ queryKey: ["skills"] }));
    await flushAsync(); // let the failed refresh reach the component

    expect(screen.queryByText("Couldn't load skills.")).toBeNull();
    expect(screen.getByLabelText("Frontend")).toBeTruthy();
  });
});
