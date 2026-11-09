// One node of the creation form: its title, skills, assignee and Add Subtask button, then its
// subtasks as nested copies of itself.
import { useEffect, useRef, type Dispatch } from "react";
import type { Developer, Id, Skill } from "../../api/types";
import { AssigneeSelect } from "../../components/AssigneeSelect";
import {
  canAddSubtaskAt,
  newDraftKey,
  nodeLabel,
  type DraftAction,
  type DraftNode,
  type Limits,
  type Path,
} from "./draft";

// A failed Save: the message for the banner, and the key of the node it is about, if the backend
// named one. A key, not an index path, so the outline stays on the node when an earlier sibling is
// removed.
export type SaveFailure = { message: string; nodeKey: string | null };

// What every node of the form needs from the page.
export type DraftFormContext = {
  developers: Developer[] | undefined; // undefined while the list loads
  skills: Skill[];
  limits: Limits;
  treeFull: boolean;
  failure: SaveFailure | null;
  dispatch: Dispatch<DraftAction>;
};

type Props = { node: DraftNode; path: Path; context: DraftFormContext };

function toggled(skillIds: Id[], skillId: Id): Id[] {
  return skillIds.includes(skillId) ? skillIds.filter((id) => id !== skillId) : [...skillIds, skillId];
}

export function TaskDraftEditor({ node, path, context }: Props) {
  const { developers, skills, limits, treeFull, failure, dispatch } = context;
  const frameRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isTopLevel = path.length === 0;
  const hasError = failure?.nodeKey === node.key;

  // Bring the failing node into view: a tree of 50 tasks can hide it off screen. Save clears the
  // failure first, so `hasError` turns false and true again on a second failed Save and this reruns.
  useEffect(() => {
    if (!hasError) return;
    frameRef.current?.scrollIntoView({ block: "center" });
    titleRef.current?.focus();
  }, [hasError]);

  function changeSkills(skillId: Id) {
    const skillIds = toggled(node.skillIds, skillId);
    dispatch({ type: "set_skills", path, skillIds, developers: developers ?? [] });
  }

  // aria-disabled, not disabled: the click that fills the tree would otherwise drop the focus. The
  // reducer refuses a full tree too, so a click on it does nothing.
  function addSubtask() {
    if (treeFull) return;
    dispatch({ type: "add_subtask", path, key: newDraftKey(), limits });
  }

  return (
    <div
      ref={frameRef}
      role="group"
      aria-label={nodeLabel(path)}
      className={hasError ? "draft-node has-error" : "draft-node"}
    >
      <div className="draft-fields">
        <label className="field">
          Title
          <input
            ref={titleRef}
            type="text"
            autoFocus
            value={node.title}
            onChange={(event) => dispatch({ type: "set_title", path, title: event.target.value })}
          />
        </label>
        {!isTopLevel && (
          <button
            type="button"
            className="icon-button"
            aria-label="Remove subtask"
            onClick={() => dispatch({ type: "remove", path })}
          >
            ×
          </button>
        )}
      </div>
      <div className="draft-fields">
        <fieldset className="skill-options">
          <legend>Skills</legend>
          {skills.map((skill) => (
            <label key={skill.id}>
              <input
                type="checkbox"
                checked={node.skillIds.includes(skill.id)}
                onChange={() => changeSkills(skill.id)}
              />
              {skill.name}
            </label>
          ))}
        </fieldset>
        <div className="field">
          Assignee
          <AssigneeSelect
            label="Assignee"
            developers={developers}
            skillIds={node.skillIds}
            value={node.assigneeId}
            onChange={(assigneeId) => dispatch({ type: "set_assignee", path, assigneeId })}
          />
        </div>
      </div>
      {node.skillIds.length === 0 && (
        <p className="muted">No skills picked: they will be identified when you save.</p>
      )}
      {canAddSubtaskAt(path, limits) && (
        <div className="draft-actions">
          <button type="button" aria-disabled={treeFull} onClick={addSubtask}>
            Add Subtask
          </button>
          {treeFull && <span className="muted">Limit of {limits.maxTreeSize} tasks reached</span>}
        </div>
      )}
      {node.subtasks.map((child, index) => (
        <TaskDraftEditor key={child.key} node={child} path={[...path, index]} context={context} />
      ))}
    </div>
  );
}
