import type { ReactNode } from "react";

type Props = {
  kind: "info" | "error";
  onDismiss?: () => void;
  children: ReactNode;
};

// role="alert" announces an error at once; role="status" waits for a pause in speech.
export function Notice({ kind, onDismiss, children }: Props) {
  return (
    <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <div className="notice-body">{children}</div>
      {onDismiss && (
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
