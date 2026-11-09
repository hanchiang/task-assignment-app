// TanStack Query hooks. Every successful change refetches the task list, so the server stays the
// only truth; the pages never patch the cache by hand.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as client from "./client";
import type { Id, NewTask, SkillsUpdate, Status, StatusChange, TaskNode } from "./types";

const tasksKey = ["tasks"] as const;

// One retry on a failed read. The default of three backed-off retries would delay "Couldn't load
// tasks" by several seconds. A change is never retried: repeating it could apply it twice.
export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1 }, mutations: { retry: false } } });

export const useTasks = () => useQuery({ queryKey: tasksKey, queryFn: client.getTasks });
export const useDevelopers = () => useQuery({ queryKey: ["developers"], queryFn: client.getDevelopers });
export const useSkills = () => useQuery({ queryKey: ["skills"], queryFn: client.getSkills });
export const useMeta = () => useQuery({ queryKey: ["meta"], queryFn: client.getMeta, staleTime: Infinity });

// What a caller does with a finished change. Passed to the hook, not to mutate(): TanStack Query
// drops the callbacks of mutate() when the component unmounts mid-save (a row whose parent was
// collapsed), but still runs the hook's own.
export type MutationCallbacks<T> = {
  onSuccess?: (data: T) => void;
  onError?: (err: Error) => void;
};

// After a success the list refetches. After TASK_NOT_FOUND it refetches too, because the task is gone.
// Both handlers wait for the refetch: TanStack Query keeps the mutation pending until they settle, so
// a control stays locked until the list shows the server's answer. The caller's callbacks run after.
function useTaskRefetchHandlers<T>(callbacks: MutationCallbacks<T> = {}) {
  const queryClient = useQueryClient();
  const refetch = () => queryClient.invalidateQueries({ queryKey: tasksKey });
  const onSuccess = async (data: T) => {
    await refetch();
    callbacks.onSuccess?.(data);
  };
  const onError = async (err: Error) => {
    const missing = err instanceof client.RequestError && err.code === "TASK_NOT_FOUND";
    if (missing) await refetch();
    callbacks.onError?.(err);
  };
  return { onSuccess, onError };
}

export function useSetStatus(callbacks?: MutationCallbacks<StatusChange>) {
  const refetchHandlers = useTaskRefetchHandlers(callbacks);
  return useMutation({
    mutationFn: (vars: { taskId: Id; status: Status }) => client.setStatus(vars.taskId, vars.status),
    ...refetchHandlers,
  });
}

export function useSetAssignee(callbacks?: MutationCallbacks<TaskNode>) {
  const refetchHandlers = useTaskRefetchHandlers(callbacks);
  return useMutation({
    mutationFn: (vars: { taskId: Id; developerId: Id | null }) =>
      client.setAssignee(vars.taskId, vars.developerId),
    ...refetchHandlers,
  });
}

export function useSetSkills() {
  const refetchHandlers = useTaskRefetchHandlers<unknown>();
  return useMutation({
    mutationFn: (vars: { taskId: Id; update: SkillsUpdate }) => client.setSkills(vars.taskId, vars.update),
    ...refetchHandlers,
  });
}

export function useCreateTask() {
  const refetchHandlers = useTaskRefetchHandlers<unknown>();
  return useMutation({
    mutationFn: (task: NewTask) => client.createTask(task),
    ...refetchHandlers,
  });
}
