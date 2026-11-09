// One row of the Task List and, below it, the rows of its subtasks. It owns the row's status and
// assignee changes, the row's error line and the skill editor's open state.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { describeFailure, isUnexpectedFailure } from "../../api/client";
import { useSetAssignee, useSetStatus } from "../../api/queries";
import type { Id, SkillSource, Status, TaskNode } from "../../api/types";
import { AssigneeSelect } from "../../components/AssigneeSelect";
import { doneProgress } from "../../lib/rules";
import { SkillEditor } from "./SkillEditor";
import { StatusSelect } from "./StatusSelect";
import type { TaskListContext } from "./taskListContext";

type TaskRowProps = { task: TaskNode; context: TaskListContext };
type SkillsCellProps = { task: TaskNode; onEdit: () => void };

// FAILED is shown as "Skills needed" instead, so its label is never displayed.
const SOURCE_LABELS: Record<SkillSource, string> = { USER: "user", LLM: "LLM", FAILED: "failed" };

// The row's depth, as a CSS variable the stylesheet turns into indentation (depth 1 is not indented).
const depthStyle = (depth: number): CSSProperties => ({ "--depth": depth - 1 }) as CSSProperties;

// One button in a fixed position, whatever the skills' source. Saving a FAILED task's skills turns
// it into a USER task; two separate buttons would make React replace the opener the skill editor
// returns focus to when it closes.
function SkillsCell({ task, onEdit }: SkillsCellProps) {
  const failed = task.skillSource === "FAILED";
  const names = task.skills.map((skill) => skill.name).join(", ");
  return (
    <>
      {failed ? (
        <span className="skills-needed">Skills needed</span>
      ) : (
        <>
          {names} <span className="muted">({SOURCE_LABELS[task.skillSource]})</span>
        </>
      )}{" "}
      <button
        type="button"
        className={failed ? undefined : "icon-button"}
        aria-label={`${failed ? "Pick skills for" : "Edit skills of"} ${task.title}`}
        onClick={onEdit}
      >
        {failed ? "Pick skills" : "✎"}
      </button>
    </>
  );
}

export function TaskRow({ task, context }: TaskRowProps) {
  const [editingSkills, setEditingSkills] = useState(false);
  const rowRef = useRef<HTMLTableRowElement>(null);

  // A rule or input error stays on the row; anything unexpected becomes the page banner. Both live in
  // the page, so the outcome of a save is kept even if this row unmounts before it ends.
  function reportFailure(err: Error) {
    if (isUnexpectedFailure(err)) context.onUnexpected(err);
    else context.onRowError(task.id, describeFailure(err));
  }

  const setStatus = useSetStatus({
    onSuccess: (change) => context.onReopened(change.reopened),
    onError: reportFailure,
  });
  const setAssignee = useSetAssignee({ onError: reportFailure });

  const rowError = context.rowErrors.get(task.id);
  const hasSubtasks = task.subtasks.length > 0;
  const expanded = !context.collapsed.has(task.id);
  const isHighlightRoot = context.highlightRootId === task.id;

  useEffect(() => {
    if (isHighlightRoot) rowRef.current?.scrollIntoView({ block: "center" });
  }, [isHighlightRoot]);

  function startChange() {
    context.onRowError(task.id, null);
    context.onChangeStart();
  }

  function changeStatus(status: Status) {
    startChange();
    setStatus.mutate({ taskId: task.id, status });
  }

  function changeAssignee(developerId: Id | null) {
    startChange();
    setAssignee.mutate({ taskId: task.id, developerId });
  }

  // While a change is saving the select shows the value just picked; on failure it falls back to the
  // server's value, which is what "the control reverts" means.
  const shownStatus = setStatus.isPending ? setStatus.variables.status : task.status;
  const savedAssigneeId = task.assignee?.id ?? null;
  const shownAssigneeId = setAssignee.isPending ? setAssignee.variables.developerId : savedAssigneeId;

  const rowClasses = [
    "task-row",
    task.status === "DONE" && "is-done",
    context.highlighted.has(task.id) && "is-highlighted",
  ];
  const progress = doneProgress(task);

  return (
    <>
      <tr
        ref={rowRef}
        className={rowClasses.filter(Boolean).join(" ")}
        onAnimationEnd={isHighlightRoot ? context.onHighlightEnd : undefined}
      >
        <td className="cell-task" style={depthStyle(task.depth)}>
          {hasSubtasks ? (
            <button
              type="button"
              className="icon-button toggle"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${task.title}`}
              onClick={() => context.toggle(task.id)}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="toggle" />
          )}
          <span className="task-title">{task.title}</span>
          {hasSubtasks && (
            <span className="muted progress">
              {progress.done}/{progress.total} done
            </span>
          )}
        </td>
        <td>
          <SkillsCell task={task} onEdit={() => setEditingSkills(true)} />
          {editingSkills && (
            <SkillEditor
              task={task}
              onClose={() => setEditingSkills(false)}
              onSaveStart={startChange}
            />
          )}
        </td>
        <td>
          <StatusSelect
            label={`Status of ${task.title}`}
            statuses={context.statuses}
            value={shownStatus}
            pending={setStatus.isPending}
            onChange={changeStatus}
          />
        </td>
        <td>
          <AssigneeSelect
            label={`Assignee of ${task.title}`}
            developers={context.developers}
            skillIds={task.skills.map((skill) => skill.id)}
            value={shownAssigneeId}
            currentName={task.assignee?.name}
            pending={setAssignee.isPending}
            onChange={changeAssignee}
          />
        </td>
      </tr>
      {rowError !== undefined && (
        <tr className="row-error">
          <td colSpan={4} style={depthStyle(task.depth)} role="alert">
            {rowError}
          </td>
        </tr>
      )}
      {expanded &&
        task.subtasks.map((subtask) => (
          <TaskRow key={subtask.id} task={subtask} context={context} />
        ))}
    </>
  );
}
