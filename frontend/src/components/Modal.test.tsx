import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

function Opener({ onCancel }: { onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal title="Edit" onCancel={onCancel}>
          <button type="button" onClick={() => setOpen(false)}>
            Inside
          </button>
        </Modal>
      )}
    </>
  );
}

describe("Modal", () => {
  it("moves focus into the dialog, and back to the opener when it closes", () => {
    render(<Opener onCancel={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();

    fireEvent.click(opener);
    const inside = screen.getByRole("button", { name: "Inside" });
    expect(document.activeElement).toBe(inside);

    fireEvent.click(inside);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("passes Esc (the cancel event) to the owner and keeps the dialog open", () => {
    const onCancel = vi.fn();
    render(<Opener onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const cancelEvent = new Event("cancel", { cancelable: true });

    fireEvent(screen.getByRole("dialog"), cancelEvent);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("tells the owner when the browser closes the dialog itself, and opens it again", () => {
    const onCancel = vi.fn();
    render(<Opener onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole<HTMLDialogElement>("dialog");

    dialog.removeAttribute("open"); // what a forced close does
    fireEvent(dialog, new Event("close"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute("open")).toBe(true);
  });

  it("survives StrictMode's second effect run: still open, still focused inside, focus returns", () => {
    render(
      <StrictMode>
        <Opener onCancel={vi.fn()} />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();

    fireEvent.click(opener);
    const inside = screen.getByRole("button", { name: "Inside" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(inside); // StrictMode's trial cleanup must not pull it out
    fireEvent.click(inside);

    expect(document.activeElement).toBe(opener);
  });
});
