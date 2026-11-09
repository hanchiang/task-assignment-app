import type { Status } from "../../api/types";

const LABELS: Record<Status, string> = {
  TODO: "To-do",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

type Props = {
  label: string; // accessible name, e.g. "Status of Avatar UI"
  statuses: Status[];
  value: Status;
  pending: boolean; // a change is saving
  onChange: (status: Status) => void;
};

// Every status is always offered, Done included. The backend refuses Done while a direct subtask is
// unfinished, and the row shows its message.
// While saving the select is aria-disabled, not disabled: a disabled control loses keyboard focus.
export function StatusSelect({ label, statuses, value, pending, onChange }: Props) {
  return (
    <select
      aria-label={label}
      aria-disabled={pending}
      value={value}
      onChange={(event) => {
        if (!pending) onChange(event.target.value as Status);
      }}
    >
      {statuses.map((status) => (
        <option key={status} value={status}>
          {LABELS[status]}
        </option>
      ))}
    </select>
  );
}
