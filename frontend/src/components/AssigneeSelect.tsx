import type { Developer, Id } from "../api/types";
import { qualifyingDevelopers } from "../lib/rules";

type Props = {
  label: string; // accessible name, e.g. "Assignee of Avatar UI"
  developers: Developer[] | undefined; // undefined while the list loads
  skillIds: Id[];
  value: Id | null;
  currentName?: string; // the assignee's name, shown while the list loads
  pending?: boolean; // a change is saving
  onChange: (developerId: Id | null) => void;
};

type Choice = { id: Id; name: string };

const UNASSIGNED = "";

// Only developers with every task skill, plus the current assignee so the select never shows a
// value it has no option for (while the list loads, or if a skill edit is still being refetched).
function choicesFor(props: Props): Choice[] {
  const { developers = [], skillIds, value, currentName } = props;
  const choices: Choice[] = qualifyingDevelopers(developers, skillIds);
  const missingCurrent = value !== null && !choices.some((choice) => choice.id === value);
  if (missingCurrent) choices.push({ id: value, name: currentName ?? "Assigned" });
  return choices;
}

// While saving the select is aria-disabled, not disabled: a disabled control loses keyboard focus.
// Before the developer list loads it is really disabled, since nothing has focus to keep yet.
export function AssigneeSelect(props: Props) {
  const { label, developers, skillIds, value, pending = false, onChange } = props;

  if (skillIds.length === 0) {
    return (
      <select aria-label={label} value={UNASSIGNED} disabled>
        <option value={UNASSIGNED}>Pick skills first</option>
      </select>
    );
  }

  return (
    <select
      aria-label={label}
      value={value ?? UNASSIGNED}
      aria-disabled={pending}
      disabled={developers === undefined}
      onChange={(event) => {
        if (!pending) onChange(event.target.value === UNASSIGNED ? null : event.target.value);
      }}
    >
      <option value={UNASSIGNED}>Unassigned</option>
      {choicesFor(props).map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.name}
        </option>
      ))}
    </select>
  );
}
