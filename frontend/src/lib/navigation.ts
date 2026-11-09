import type { Id } from "../api/types";

// Router state the creation page leaves for the Task List: the new top-level task to highlight.
export type HighlightState = { highlightId: Id };

export function readHighlightId(state: unknown): Id | undefined {
  const id = (state as Partial<HighlightState> | null)?.highlightId;
  return typeof id === "string" ? id : undefined;
}
