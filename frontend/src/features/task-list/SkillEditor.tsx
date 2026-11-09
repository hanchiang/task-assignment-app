// The modal that edits one task's skills, and the confirm it opens when the backend answers 409
// SKILL_EDIT_BREAKS_ASSIGNMENT. The backend decides; this component only shows its answer.
import { useState } from "react";
import { RequestError, describeFailure } from "../../api/client";
import { useSetSkills, useSkills } from "../../api/queries";
import type { Id, SkillEditConflict, SkillsUpdate, TaskNode } from "../../api/types";
import { Modal } from "../../components/Modal";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  task: TaskNode;
  onClose: () => void;
  onSaveStart: () => void; // a save begins: the page clears its banners
};

// Returns the 409's details only in the expected shape; anything else shows as a plain error.
function readConflict(err: unknown): SkillEditConflict | null {
  if (!(err instanceof RequestError) || err.code !== "SKILL_EDIT_BREAKS_ASSIGNMENT") return null;
  const details = err.details as Partial<SkillEditConflict> | undefined;
  const hasShape = details?.assignee !== undefined && Array.isArray(details.missingSkills);
  return hasShape ? (details as SkillEditConflict) : null;
}

// The backend's 409 answered one set of skills. Confirm resends that set, not whatever the boxes show
// by then.
type PendingConflict = { details: SkillEditConflict; skillIds: Id[] };

export function SkillEditor({ task, onClose, onSaveStart }: Props) {
  const skills = useSkills();
  const setSkills = useSetSkills();
  const [picked, setPicked] = useState<Id[]>(() => task.skills.map((skill) => skill.id));
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Closing while a save is in flight would lose its result, so Cancel and Esc wait for the answer.
  const saving = setSkills.isPending;
  const canSave = picked.length > 0 && skills.data !== undefined;

  function toggle(skillId: Id) {
    const next = picked.includes(skillId)
      ? picked.filter((id) => id !== skillId)
      : [...picked, skillId];
    setPicked(next);
  }

  function handleError(err: Error, skillIds: Id[]) {
    const details = readConflict(err);
    setConflict(details && { details, skillIds });
    setFailure(details ? null : describeFailure(err));
  }

  function save(skillIds: Id[], unassignIfUnqualified: boolean) {
    if (saving) return; // the Save buttons stay focusable while saving, so a click can still arrive
    const update: SkillsUpdate = unassignIfUnqualified
      ? { skillIds, unassignIfUnqualified: true }
      : { skillIds };
    onSaveStart();
    setFailure(null);
    // Callbacks on mutate() are safe here: the open modal makes the page inert, so this editor stays
    // mounted until they run. Row-level changes use hook-level callbacks instead (api/queries.ts).
    setSkills.mutate(
      { taskId: task.id, update },
      { onSuccess: onClose, onError: (err) => handleError(err, skillIds) },
    );
  }

  function cancelEditor() {
    if (!saving) onClose();
  }

  function cancelConfirm() {
    if (!saving) setConflict(null);
  }

  return (
    <>
      <Modal title={`Skills for “${task.title}”`} onCancel={cancelEditor}>
        {skills.isPending && <p>Loading skills…</p>}
        {skills.isError && skills.data === undefined && (
          <p className="error-text" role="alert">
            Couldn&apos;t load skills.
          </p>
        )}
        <div className="skill-options">
          {skills.data?.map((skill) => (
            <label key={skill.id}>
              <input
                type="checkbox"
                checked={picked.includes(skill.id)}
                onChange={() => toggle(skill.id)}
              />
              {skill.name}
            </label>
          ))}
        </div>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={cancelEditor}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canSave}
            aria-disabled={saving}
            onClick={() => save(picked, false)}
          >
            Save
          </button>
        </div>
      </Modal>
      {conflict && (
        <ConfirmDialog
          conflict={conflict.details}
          busy={saving}
          onConfirm={() => save(conflict.skillIds, true)}
          onCancel={cancelConfirm}
        />
      )}
    </>
  );
}
