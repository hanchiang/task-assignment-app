// The Task List page: loads tasks, statuses and developers, shows the page-level banners, and gives
// every row the context it needs. Row changes themselves live in TaskRow.
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { describeFailure } from "../../api/client";
import { useDevelopers, useMeta, useTasks } from "../../api/queries";
import type { Id, Status, TaskNode, TaskRef } from "../../api/types";
import { Notice } from "../../components/Notice";
import { readHighlightId } from "../../lib/navigation";
import { TaskTable } from "./TaskTable";
import type { TaskListContext } from "./taskListContext";

function collectIds(task: TaskNode): Id[] {
  return [task.id, ...task.subtasks.flatMap(collectIds)];
}

function treeIds(tasks: TaskNode[], rootId: Id | undefined): Set<Id> {
  const root = tasks.find((task) => task.id === rootId);
  return new Set(root ? collectIds(root) : []);
}

const reopenedText = (reopened: TaskRef[]): string =>
  `${reopened.map((task) => task.title).join(", ")} moved back to In Progress.`;

export function TaskListPage() {
  const tasks = useTasks();
  const meta = useMeta();
  const developers = useDevelopers();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(new Set());
  const [reopenedNotice, setReopenedNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<Id, string>>(new Map());
  const [highlightId, setHighlightId] = useState(() => readHighlightId(location.state));

  // The router keeps `state` across a reload, which would replay the highlight; take it out of the
  // history entry once it is read.
  const arrivedWithHighlight = readHighlightId(location.state) !== undefined;
  useEffect(() => {
    if (arrivedWithHighlight) navigate(location.pathname, { replace: true, state: null });
  }, [arrivedWithHighlight, navigate, location.pathname]);

  function toggle(taskId: Id) {
    const next = new Set(collapsed);
    if (!next.delete(taskId)) next.add(taskId);
    setCollapsed(next);
  }

  function setRowError(taskId: Id, message: string | null) {
    setRowErrors((current) => {
      const next = new Map(current);
      if (message === null) next.delete(taskId);
      else next.set(taskId, message);
      return next;
    });
  }

  function clearBanners() {
    setReopenedNotice(null);
    setErrorNotice(null);
  }

  // Only a non-empty answer sets the banner. A change that reopens nothing must not clear the banner
  // a different row's change just raised; the start of a change already cleared the old one.
  function showReopened(reopened: TaskRef[]) {
    if (reopened.length > 0) setReopenedNotice(reopenedText(reopened));
  }

  function showUnexpected(err: unknown) {
    setErrorNotice(describeFailure(err));
  }

  function contextFor(statuses: Status[]): TaskListContext {
    return {
      developers: developers.data,
      statuses,
      collapsed,
      toggle,
      highlighted: treeIds(tasks.data ?? [], highlightId),
      highlightRootId: highlightId,
      onHighlightEnd: () => setHighlightId(undefined),
      rowErrors,
      onRowError: setRowError,
      onChangeStart: clearBanners,
      onReopened: showReopened,
      onUnexpected: showUnexpected,
    };
  }

  // Only a read that failed with nothing loaded blocks the page. A failed refetch keeps the old rows
  // and shows a notice instead.
  const reads = [
    { name: "the task list", query: tasks },
    { name: "the statuses", query: meta },
    { name: "the developer list", query: developers },
  ];
  const failedReads = reads.filter(({ query }) => query.isError && query.data === undefined);
  const refreshFailed = tasks.isError && tasks.data !== undefined;

  function retryFailedReads() {
    for (const { query } of reads) {
      if (query.isError) void query.refetch();
    }
  }

  function renderBody() {
    if (failedReads.length > 0) {
      const names = failedReads.map(({ name }) => name).join(" and ");
      return (
        <p>
          Couldn&apos;t load {names}.{" "}
          <button type="button" onClick={retryFailedReads}>
            Retry
          </button>
        </p>
      );
    }
    if (tasks.data === undefined || meta.data === undefined) return <p>Loading tasks…</p>;
    if (tasks.data.length === 0) {
      return (
        <p>
          No tasks yet. <Link to="/tasks/new">Create a task</Link>
        </p>
      );
    }
    return <TaskTable tasks={tasks.data} context={contextFor(meta.data.statuses)} />;
  }

  return (
    <section>
      <div className="page-heading">
        <h1>Tasks</h1>
        <Link to="/tasks/new" className="button primary">
          + New task
        </Link>
      </div>
      {errorNotice && (
        <Notice kind="error" onDismiss={() => setErrorNotice(null)}>
          {errorNotice}
        </Notice>
      )}
      {refreshFailed && (
        <Notice kind="error">
          Couldn&apos;t refresh tasks; the list may be out of date.{" "}
          <button type="button" onClick={retryFailedReads}>
            Retry
          </button>
        </Notice>
      )}
      {reopenedNotice && (
        <Notice kind="info" onDismiss={() => setReopenedNotice(null)}>
          {reopenedNotice}
        </Notice>
      )}
      {renderBody()}
    </section>
  );
}
