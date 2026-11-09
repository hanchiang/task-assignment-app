import type { Developer, Id, Status, TaskRef } from "../../api/types";

// What every row needs from the page: lookups, display state, and the page-level banners.
export type TaskListContext = {
  developers: Developer[] | undefined; // undefined while the list loads
  statuses: Status[];
  collapsed: ReadonlySet<Id>;
  toggle: (taskId: Id) => void;
  highlighted: ReadonlySet<Id>; // the tree just created, if any
  // The new tree's top-level task: scrolled into view, and its animation end clears the highlight.
  highlightRootId: Id | undefined;
  onHighlightEnd: () => void;
  // A rule or input error under each row, by task id. Kept here, not in the row, so it survives the row
  // being unmounted (parent collapsed) while its change is saving.
  rowErrors: ReadonlyMap<Id, string>;
  onRowError: (taskId: Id, message: string | null) => void;
  onChangeStart: () => void; // a change begins: clear the banners
  onReopened: (reopened: TaskRef[]) => void;
  onUnexpected: (err: unknown) => void; // 500, network error, 504: shown as the page banner
};
