import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const conflict = { assignee: { id: "d-alice", name: "Alice" }, missingSkills: ["Backend"] };

function renderDialog(busy = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConfirmDialog conflict={conflict} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("names the assignee and the missing skills", () => {
    renderDialog();
    expect(screen.getByText("Alice lacks Backend.")).toBeTruthy();
    expect(screen.getByText("Saving will unassign Alice from this task.")).toBeTruthy();
  });

  it("focuses Cancel first, so a stray Enter cannot unassign anyone", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("treats Esc (the dialog's cancel event) as Cancel and keeps the dialog mounted", () => {
    const { onCancel, onConfirm } = renderDialog();
    const cancelEvent = new Event("cancel", { cancelable: true });

    fireEvent(screen.getByRole("dialog"), cancelEvent);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(cancelEvent.defaultPrevented).toBe(true);
  });

  it("confirms with the second button", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Save and unassign" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps both buttons focusable and inert while the save runs", () => {
    const { onConfirm, onCancel } = renderDialog(true);
    const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "Save and unassign" });
    const cancel = screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" });

    for (const button of [confirm, cancel]) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
    }

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
