import { useEffect, useId, useRef, type ReactNode, type SyntheticEvent } from "react";

type Props = {
  title: string;
  onCancel: () => void;
  children: ReactNode;
};

// A native <dialog> opened with showModal(): the browser dims the page, traps focus, focuses the
// first control and sends Esc as a `cancel` event. Clicking the backdrop does nothing. A second
// Modal opened while this one is open stacks above it. On unmount, focus goes back to the control
// that was focused when it opened, because the browser would otherwise drop it to <body>.
export function Modal({ title, onCancel, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Kept across StrictMode's second effect run, when focus is already inside the dialog.
    openerRef.current ??= document.activeElement;
    if (!dialog.open) dialog.showModal();

    return () => {
      // Only a real unmount, which has detached the dialog. StrictMode's trial cleanup leaves it
      // attached, and refocusing the opener then would pull focus out of the open dialog.
      const opener = openerRef.current;
      const unmounted = !dialog.isConnected;
      if (unmounted && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  function handleCancel(event: SyntheticEvent) {
    event.preventDefault(); // keep the dialog mounted; the owner decides what Esc means
    onCancel();
  }

  // Chrome can close a dialog itself on a second Esc press, past the cancel event above. Tell the
  // owner, and open it again if the owner kept it mounted, so it never sits there invisible.
  function handleClose(event: SyntheticEvent<HTMLDialogElement>) {
    onCancel();
    const dialog = event.currentTarget;
    if (!dialog.open) dialog.showModal();
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
