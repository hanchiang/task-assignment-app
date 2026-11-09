// The Task Creation page: the draft tree, Save with its pending and failed states, and the
// hand-off to the Task List (with the new task's id, so the list can highlight it).
import { useEffect, useReducer, useState, type FormEvent } from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import { RequestError, describeFailure, isUnexpectedFailure } from "../../api/client";
import { useCreateTask, useDevelopers, useMeta, useSkills } from "../../api/queries";
import { Notice } from "../../components/Notice";
import type { HighlightState } from "../../lib/navigation";
import {
  draftReducer,
  hasEmptyTitle,
  isTreeFull,
  newDraftNode,
  nodeAt,
  readNodePath,
  toNewTask,
  type DraftNode,
  type Limits,
} from "./draft";
import { TaskDraftEditor, type SaveFailure } from "./TaskDraftEditor";

// `sent` is the tree the request carried: the backend's details.path indexes into it, and the user
// may have edited or removed nodes since.
function toSaveFailure(err: Error, sent: DraftNode): SaveFailure {
  const unexpected = isUnexpectedFailure(err);
  const message = unexpected ? `Save failed. ${describeFailure(err)}` : describeFailure(err);
  const path = !unexpected && err instanceof RequestError ? readNodePath(err.details) : null;
  const node = path ? nodeAt(sent, path) : undefined;
  return { message, nodeKey: node?.key ?? null };
}

export function TaskCreatePage() {
  const navigate = useNavigate();
  const meta = useMeta();
  const developers = useDevelopers();
  const skills = useSkills();
  const createTask = useCreateTask();
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => newDraftNode());
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  const reads = [meta, developers, skills];
  const loadFailed = reads.some((query) => query.isError && query.data === undefined);
  const limits: Limits | null = meta.data ?? null;
  const ready = limits !== null && developers.data !== undefined && skills.data !== undefined;
  const canSave = ready && !hasEmptyTitle(draft);
  const saving = createTask.isPending;

  // Leaving mid-Save (header link, Back, Cancel) would unmount this page and drop mutate()'s
  // callbacks: no highlight on success, and a failure lost with the draft. Refuse the navigation.
  const blocker = useBlocker(saving);
  useEffect(() => {
    if (blocker.state === "blocked") blocker.reset();
  }, [blocker]);

  // Declared after useBlocker on purpose: effects run in order, so the blocker has already seen
  // `saving` turn false when this navigates. From the mutate() callback it would still be blocked.
  const createdId = createTask.data?.id;
  useEffect(() => {
    if (createdId === undefined) return;
    const state: HighlightState = { highlightId: createdId };
    navigate("/", { state });
  }, [createdId, navigate]);

  function retryLoad() {
    for (const query of reads) {
      if (query.isError) void query.refetch();
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return; // Save stays focusable while saving, so a click or Enter can still arrive
    setFailure(null);
    // Callbacks on mutate() are safe here: the blocker above keeps this page mounted while saving.
    createTask.mutate(toNewTask(draft), {
      onError: (err) => setFailure(toSaveFailure(err, draft)),
    });
  }

  return (
    <section>
      <h1>Create Task(s)</h1>
      {loadFailed && (
        <Notice kind="error">
          Couldn&apos;t load the form data.{" "}
          <button type="button" onClick={retryLoad}>
            Retry
          </button>
        </Notice>
      )}
      <form onSubmit={save}>
        {!limits && !loadFailed && <p>Loading…</p>}
        {limits && (
          <TaskDraftEditor
            node={draft}
            path={[]}
            context={{
              developers: developers.data,
              skills: skills.data ?? [],
              limits,
              treeFull: isTreeFull(draft, limits),
              failure,
              dispatch,
            }}
          />
        )}
        {failure && <Notice kind="error">{failure.message}</Notice>}
        <div className="form-actions">
          <Link
            to="/"
            className="button"
            aria-disabled={saving}
          >
            Cancel
          </Link>
          <button type="submit" className="primary" disabled={!canSave} aria-disabled={saving}>
            {saving ? "Saving — identifying skills…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
