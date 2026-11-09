import { Modal } from "../../components/Modal";
import type { SkillEditConflict } from "../../api/types";

type Props = {
  conflict: SkillEditConflict;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Cancel comes first in the DOM, so showModal() focuses it: a stray Enter cannot unassign anyone.
// While the save runs the buttons are aria-disabled, not disabled, so the focused one keeps focus.
export function ConfirmDialog({ conflict, busy, onConfirm, onCancel }: Props) {
  const { assignee, missingSkills } = conflict;
  const unlessBusy = (action: () => void) => () => {
    if (!busy) action();
  };
  return (
    <Modal title="Change skills?" onCancel={onCancel}>
      <p>
        {assignee.name} lacks {missingSkills.join(", ")}.
      </p>
      <p>Saving will unassign {assignee.name} from this task.</p>
      <div className="modal-actions">
        <button type="button" aria-disabled={busy} onClick={unlessBusy(onCancel)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          aria-disabled={busy}
          onClick={unlessBusy(onConfirm)}
        >
          Save and unassign
        </button>
      </div>
    </Modal>
  );
}
