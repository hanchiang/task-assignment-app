import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, makeTask, testQueryClient } from "../test/fixtures";
import * as client from "./client";
import { createQueryClient, useSetStatus, useTasks, type MutationCallbacks } from "./queries";
import type { StatusChange, TaskNode } from "./types";

// The API client is stubbed, so no test here reaches the network.
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  getTasks: vi.fn(),
  setStatus: vi.fn(),
}));

function renderHooks(callbacks?: MutationCallbacks<StatusChange>) {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hooks = renderHook(
    () => ({ tasks: useTasks(), setStatus: useSetStatus(callbacks) }),
    { wrapper },
  );
  return { ...hooks, queryClient };
}

const change: StatusChange = { task: makeTask(), reopened: [] };

beforeEach(() => vi.clearAllMocks());

describe("mutations", () => {
  it("stay pending until the task list refetch lands", async () => {
    const refetch = deferred<TaskNode[]>();
    vi.mocked(client.getTasks).mockResolvedValueOnce([makeTask()]).mockReturnValueOnce(refetch.promise);
    vi.mocked(client.setStatus).mockResolvedValueOnce(change);
    const { result } = renderHooks();
    await waitFor(() => expect(result.current.tasks.data).toHaveLength(1));

    act(() => result.current.setStatus.mutate({ taskId: "t1", status: "DONE" }));

    await waitFor(() => expect(client.getTasks).toHaveBeenCalledTimes(2));
    expect(client.setStatus).toHaveBeenCalledTimes(1);
    expect(result.current.setStatus.isPending).toBe(true); // saved, but the list has not caught up

    await act(async () => refetch.resolve([makeTask({ status: "DONE" })]));
    await waitFor(() => expect(result.current.setStatus.isSuccess).toBe(true));
    expect(result.current.tasks.data?.[0]?.status).toBe("DONE");
  });

  it("run the caller's onSuccess only after the refetched list is in the cache", async () => {
    const refetch = deferred<TaskNode[]>();
    vi.mocked(client.getTasks).mockResolvedValueOnce([makeTask()]).mockReturnValueOnce(refetch.promise);
    vi.mocked(client.setStatus).mockResolvedValueOnce(change);
    let cachedWhenCalled: unknown;
    const onSuccess = vi.fn(() => {
      cachedWhenCalled = queryClient.getQueryData(["tasks"]);
    });
    const { result, queryClient } = renderHooks({ onSuccess });
    await waitFor(() => expect(result.current.tasks.data).toHaveLength(1));

    act(() => result.current.setStatus.mutate({ taskId: "t1", status: "DONE" }));
    await waitFor(() => expect(client.getTasks).toHaveBeenCalledTimes(2));
    expect(onSuccess).not.toHaveBeenCalled(); // saved, but the refetch has not landed

    const refreshed = [makeTask({ status: "DONE" })];
    await act(async () => refetch.resolve(refreshed));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(cachedWhenCalled).toEqual(refreshed);
  });

  it("refetch the list after TASK_NOT_FOUND, since the task is gone", async () => {
    vi.mocked(client.getTasks).mockResolvedValue([makeTask()]);
    vi.mocked(client.setStatus).mockRejectedValueOnce(
      new client.RequestError(404, "TASK_NOT_FOUND", "No such task.", undefined, "r1"),
    );
    const { result } = renderHooks();
    await waitFor(() => expect(result.current.tasks.data).toHaveLength(1));

    act(() => result.current.setStatus.mutate({ taskId: "t1", status: "DONE" }));

    await waitFor(() => expect(result.current.setStatus.isError).toBe(true));
    expect(client.getTasks).toHaveBeenCalledTimes(2);
  });
});

describe("createQueryClient", () => {
  it("retries a failed read once and never retries a change", () => {
    const options = createQueryClient().getDefaultOptions();
    expect(options.queries?.retry).toBe(1);
    expect(options.mutations?.retry).toBe(false);
  });
});
