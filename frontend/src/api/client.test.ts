import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NETWORK_ERROR,
  RequestError,
  UNEXPECTED_RESPONSE,
  getTasks,
  isUnexpectedFailure,
  setSkills,
} from "./client";

// fetch is stubbed in every test, so nothing here touches the network.
function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function failure(call: Promise<unknown>): Promise<RequestError> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RequestError);
  return err as RequestError;
}

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("returns the parsed body of a successful call", async () => {
    stubFetch(json([{ id: "t1" }], 200));
    expect(await getTasks()).toEqual([{ id: "t1" }]);
  });

  it("sends a JSON body with a content type", async () => {
    const fetchMock = stubFetch(json({ id: "t1" }, 200));
    await setSkills("t1", { skillIds: ["s1"], unassignIfUnqualified: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/t1/skills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: ["s1"], unassignIfUnqualified: true }),
    });
  });

  it("turns the API's error body into a RequestError", async () => {
    const error = {
      code: "SKILL_EDIT_BREAKS_ASSIGNMENT",
      message: "Alice lacks Backend.",
      requestId: "r1",
      details: { x: 1 },
    };
    stubFetch(json({ error }, 409));
    const err = await failure(setSkills("t1", { skillIds: ["s1"] }));
    expect([err.status, err.code, err.message, err.requestId, err.details]).toEqual([
      409,
      "SKILL_EDIT_BREAKS_ASSIGNMENT",
      "Alice lacks Backend.",
      "r1",
      { x: 1 },
    ]);
    expect(isUnexpectedFailure(err)).toBe(false);
  });

  it("reports a network failure with status 0", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    const err = await failure(getTasks());
    expect([err.status, err.code]).toEqual([0, NETWORK_ERROR]);
    expect(isUnexpectedFailure(err)).toBe(true);
  });

  it("reports a 2xx reply that is not JSON as unreadable, not as a status", async () => {
    stubFetch(new Response("<html>hello</html>", { status: 200 }));
    const err = await failure(getTasks());
    expect([err.status, err.code]).toEqual([200, UNEXPECTED_RESPONSE]);
    expect(err.message).toBe("The server sent a reply the app could not read.");
  });

  it("reports a non-JSON error page, such as nginx's 504, as unexpected", async () => {
    stubFetch(new Response("<html>504 Gateway Time-out</html>", { status: 504 }));
    const err = await failure(getTasks());
    expect([err.status, err.code]).toEqual([504, UNEXPECTED_RESPONSE]);
    expect(isUnexpectedFailure(err)).toBe(true);
  });

  it("treats a 500 with the API's error body as unexpected and keeps its request id", async () => {
    const error = { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId: "r9" };
    stubFetch(json({ error }, 500));
    const err = await failure(getTasks());
    expect(err.requestId).toBe("r9");
    expect(isUnexpectedFailure(err)).toBe(true);
  });
});
