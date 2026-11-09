// End-to-end flows over HTTP against a running stack (the Docker image, compose wiring and db/init SQL),
// which api.test.ts cannot reach: it runs in-process. scripts/e2e.sh starts a throwaway stack and sets
// E2E_BASE_URL; without it this file is skipped, so `npm test` needs no stack.
import { describe, expect, it } from "vitest";
import type { TaskNode } from "../src/tasks/schemas.js";
import { DEV, SKILL } from "./db.js";

const BASE = process.env.E2E_BASE_URL;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // any, as with app.inject's json() in api.test.ts: the assertions check the shape.
  return { status: res.status, body: (await res.json()) as any };
}

const put = (path: string, body: unknown) => call("PUT", path, body);
const rejected = (status: number, code: string) => ({ status, body: { error: { code } } });

describe.skipIf(!BASE)("end to end", () => {
  it("serves health and the seeded developers", async () => {
    expect(await call("GET", "/api/health")).toEqual({ status: 200, body: { ok: true } });
    const devs = await call("GET", "/api/developers");
    expect(devs.status).toBe(200);
    expect(devs.body.map((d: { name: string }) => d.name).sort()).toEqual(["Alice", "Bob", "Carol", "Dave"]);
  });

  it("creates, assigns, completes, reopens and re-skills a nested tree", async () => {
    const created = await call("POST", "/api/tasks", {
      title: "Profile update",
      skillIds: [SKILL.Frontend],
      subtasks: [
        { title: "Avatar UI", skillIds: [SKILL.Frontend] },
        { title: "Profile API", skillIds: [SKILL.Backend], subtasks: [{ title: "Validation", skillIds: [SKILL.Backend] }] },
      ],
    });
    expect(created.status).toBe(201);
    const root: TaskNode = created.body;
    const [avatar, api] = root.subtasks;
    const validation = api!.subtasks[0]!;
    expect(root.subtasks.map((t) => t.title)).toEqual(["Avatar UI", "Profile API"]);
    expect(validation.depth).toBe(3);

    // Assignment needs every task skill.
    const wrong = await put(`/api/tasks/${avatar!.id}/assignee`, { developerId: DEV.Bob });
    expect(wrong).toMatchObject(rejected(409, "ASSIGNEE_LACKS_SKILLS"));
    const assigned = await put(`/api/tasks/${avatar!.id}/assignee`, { developerId: DEV.Alice });
    expect(assigned).toMatchObject({ status: 200, body: { assignee: { id: DEV.Alice, name: "Alice" } } });

    // Done needs every subtask Done.
    const early = await put(`/api/tasks/${root.id}/status`, { status: "DONE" });
    expect(early).toMatchObject(rejected(409, "SUBTASKS_NOT_DONE"));
    for (const t of [validation, api!, avatar!, root]) {
      expect((await put(`/api/tasks/${t.id}/status`, { status: "DONE" })).status).toBe(200);
    }

    // Reopening a subtask reopens its Done ancestors.
    const reopen = await put(`/api/tasks/${validation.id}/status`, { status: "IN_PROGRESS" });
    expect(reopen.body.reopened.map((r: { id: string }) => r.id).sort()).toEqual([api!.id, root.id].sort());
    const tree: TaskNode = (await call("GET", `/api/tasks/${root.id}`)).body;
    expect(tree).toMatchObject({ status: "IN_PROGRESS", subtasks: [{}, { status: "IN_PROGRESS" }] });

    // A skill edit that the assignee no longer meets is rejected, then applied with the flag.
    const edit = await put(`/api/tasks/${avatar!.id}/skills`, { skillIds: [SKILL.Backend] });
    expect(edit).toMatchObject(rejected(409, "SKILL_EDIT_BREAKS_ASSIGNMENT"));
    const forced = await put(`/api/tasks/${avatar!.id}/skills`, { skillIds: [SKILL.Backend], unassignIfUnqualified: true });
    expect(forced).toMatchObject({ status: 200, body: { assignee: null, skills: [{ name: "Backend" }] } });

    const list = await call("GET", "/api/tasks");
    expect(list.body.map((t: TaskNode) => t.id)).toContain(root.id);
  });

  it("saves a task given no skills as FAILED, since no skill identifier is connected", async () => {
    const created = await call("POST", "/api/tasks", { title: "Write release notes" });
    expect(created).toMatchObject({ status: 201, body: { skillSource: "FAILED", skills: [] } });
  });
});
