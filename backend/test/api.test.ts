// API tests: every endpoint and error code through app.inject, against a real PostgreSQL schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db.js";
import { FakeSkillIdentifier } from "../src/llm/fake.js";
import { insertTree } from "../src/tasks/repo.js";
import type { TaskNode } from "../src/tasks/schemas.js";
import { createTestDb, DEV, SKILL, type TestDb } from "./db.js";

let db: TestDb;
let fake: FakeSkillIdentifier;
let app: ReturnType<typeof buildApp>;

const MISSING_ID = "01a1bd9a-c800-7000-8000-00000000ffff";

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await app?.close();
  await db.cleanup();
});
beforeEach(async () => {
  await db.pool.query("TRUNCATE task_skill, task");
  fake = new FakeSkillIdentifier({
    "Responsive homepage": ["Frontend"],
    "Audit logs": ["Backend"],
    "Profile update": ["Frontend", "Backend", "Frontend"],
    "Unknown names": ["Design", "Ops"],
  });
  await app?.close();
  app = buildApp({ pool: db.pool, identifier: fake });
});

const create = (body: unknown) => app.inject({ method: "POST", url: "/api/tasks", payload: body as object });
const put = (id: string, what: string, body: unknown) =>
  app.inject({ method: "PUT", url: `/api/tasks/${id}/${what}`, payload: body as object });
const taskCount = async () => Number((await db.pool.query("SELECT count(*) FROM task")).rows[0].count);

async function createOk(body: unknown): Promise<TaskNode> {
  const res = await create(body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("reads", () => {
  it("GET /api/meta returns the limits and statuses", async () => {
    const res = await app.inject("/api/meta");
    expect(res.json()).toEqual({ maxDepth: 3, maxTreeSize: 50, statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] });
  });

  it("GET /api/health answers ok", async () => {
    expect((await app.inject("/api/health")).json()).toEqual({ ok: true });
  });

  it("lists developers by name with their skills by name", async () => {
    const devs = (await app.inject("/api/developers")).json();
    expect(devs.map((d: { name: string }) => d.name)).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    expect(devs[2].skills).toEqual([
      { id: SKILL.Backend, name: "Backend" },
      { id: SKILL.Frontend, name: "Frontend" },
    ]);
  });

  it("reads a developer with assigned tasks", async () => {
    const t = await createOk({ title: "Avatar UI", skillIds: [SKILL.Frontend], assigneeId: DEV.Alice });
    const res = await app.inject(`/api/developers/${DEV.Alice}`);
    expect(res.json()).toMatchObject({ name: "Alice", assignedTasks: [{ id: t.id, title: "Avatar UI", status: "TODO" }] });
  });

  it("lists skills and reads one skill", async () => {
    expect((await app.inject("/api/skills")).json().map((s: { name: string }) => s.name)).toEqual(["Backend", "Frontend"]);
    const fe = (await app.inject(`/api/skills/${SKILL.Frontend}`)).json();
    expect(fe).toEqual({ id: SKILL.Frontend, name: "Frontend" });
  });

  it.each([
    ["/api/tasks/", "TASK_NOT_FOUND"],
    ["/api/developers/", "DEVELOPER_NOT_FOUND"],
    ["/api/skills/", "SKILL_NOT_FOUND"],
  ])("%s:id gives 404 for an unknown id and 400 for a malformed one", async (base, code) => {
    const missing = await app.inject(base + MISSING_ID);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code, requestId: expect.any(String) });
    const malformed = await app.inject(base + "abc");
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("input checks shared by the PUT routes", () => {
  it.each([
    ["status", { status: "DONE" }],
    ["assignee", { developerId: null }],
    ["skills", { skillIds: [SKILL.Backend] }],
  ])("PUT /api/tasks/abc/%s gives 400 VALIDATION_ERROR", async (what, body) => {
    const res = await put("abc", what, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    // Only the create endpoint adds details (its subtask path).
    expect(res.json().error.details).toBeUndefined();
  });

  it("GET /api/health gives 503 when the database does not answer", async () => {
    const pg = await import("pg");
    const dead = new pg.default.Pool({ connectionString: "postgres://x:x@127.0.0.1:1/x", connectionTimeoutMillis: 500 });
    const deadApp = buildApp({ pool: dead, identifier: fake });
    const res = await deadApp.inject("/api/health");
    expect(res.statusCode).toBe(503);
    await deadApp.close();
    await dead.end();
  });
});

describe("insertTree", () => {
  // The create path always lists parents first; this checks the documented claim that order does not matter.
  it("accepts a child row listed before its parent", async () => {
    const [root, child] = ["01a1bd9a-c800-7000-8000-00000000a001", "01a1bd9a-c800-7000-8000-00000000a002"];
    const row = { title: "t", skillSource: "USER" as const, rootId: root, position: 0, assigneeId: null, skillIds: [] };
    await withTransaction(db.pool, (tx) =>
      insertTree(tx, [{ ...row, id: child, parentId: root }, { ...row, id: root, parentId: null }]),
    );
    const tree = (await app.inject(`/api/tasks/${root}`)).json();
    expect(tree).toMatchObject({ id: root, subtasks: [{ id: child, parentId: root }] });
  });
});

describe("POST /api/tasks", () => {
  it("creates a nested tree in form order, with depth, skills and sources", async () => {
    const t = await createOk({
      title: "Profile update",
      subtasks: [
        { title: "Avatar UI", skillIds: [SKILL.Frontend, SKILL.Frontend], assigneeId: DEV.Alice, subtasks: [{ title: "Responsive homepage" }] },
        { title: "Audit logs" },
        { title: "Write onboarding docs" },
      ],
    });
    expect(t).toMatchObject({ title: "Profile update", depth: 1, parentId: null, status: "TODO", skillSource: "LLM" });
    expect(t.skills.map((s) => s.name)).toEqual(["Backend", "Frontend"]);
    expect(t.subtasks.map((s) => s.title)).toEqual(["Avatar UI", "Audit logs", "Write onboarding docs"]);
    const [avatar, audit, docs] = t.subtasks;
    expect(avatar).toMatchObject({ depth: 2, parentId: t.id, skillSource: "USER", assignee: { id: DEV.Alice, name: "Alice" } });
    expect(avatar!.skills).toEqual([{ id: SKILL.Frontend, name: "Frontend" }]);
    expect(avatar!.subtasks[0]).toMatchObject({ depth: 3, skillSource: "LLM", skills: [{ name: "Frontend" }] });
    expect(audit).toMatchObject({ skillSource: "LLM", skills: [{ name: "Backend" }] });
    expect(docs).toMatchObject({ skillSource: "FAILED", skills: [] });
    // One call for every skill-less title in the tree.
    expect(fake.calls).toEqual([["Profile update", "Responsive homepage", "Audit logs", "Write onboarding docs"]]);
    // GET returns the same tree, subtasks in position order.
    expect((await app.inject(`/api/tasks/${t.id}`)).json()).toEqual(t);
  });

  it("does not call the LLM when every task has user skills", async () => {
    await createOk({ title: "a", skillIds: [SKILL.Backend] });
    expect(fake.calls).toEqual([]);
  });

  it("saves as FAILED when the LLM names no existing skill", async () => {
    const t = await createOk({ title: "Unknown names" });
    expect(t).toMatchObject({ skillSource: "FAILED", skills: [] });
  });

  it("lists top-level tasks in creation order", async () => {
    const a = await createOk({ title: "first", skillIds: [SKILL.Backend] });
    const b = await createOk({ title: "second", skillIds: [SKILL.Backend] });
    const list = (await app.inject("/api/tasks")).json();
    expect(list.map((t: TaskNode) => t.id)).toEqual([a.id, b.id]);
  });

  it("returns a subtree with absolute depth from GET /api/tasks/:id", async () => {
    const t = await createOk({ title: "r", skillIds: [SKILL.Backend], subtasks: [{ title: "c", skillIds: [SKILL.Backend] }] });
    const child = (await app.inject(`/api/tasks/${t.subtasks[0]!.id}`)).json();
    expect(child).toMatchObject({ title: "c", depth: 2, parentId: t.id });
  });

  it.each([
    ["an empty title", { title: "   " }, 400, "VALIDATION_ERROR"],
    ["a title over 500 characters", { title: "x".repeat(501) }, 400, "VALIDATION_ERROR"],
    ["a malformed skill id", { title: "a", skillIds: ["nope"] }, 400, "VALIDATION_ERROR"],
    ["an unknown skill id", { title: "a", skillIds: [MISSING_ID] }, 400, "VALIDATION_ERROR"],
    ["an unknown developer", { title: "a", skillIds: [SKILL.Backend], assigneeId: MISSING_ID }, 400, "VALIDATION_ERROR"],
    ["an assignee without skills", { title: "a", assigneeId: DEV.Bob }, 400, "ASSIGNEE_WITHOUT_USER_SKILLS"],
    ["an unqualified assignee", { title: "a", skillIds: [SKILL.Frontend], assigneeId: DEV.Bob }, 409, "ASSIGNEE_LACKS_SKILLS"],
    ["a 4-level tree", { title: "1", subtasks: [{ title: "2", subtasks: [{ title: "3", subtasks: [{ title: "4" }] }] }] }, 400, "NESTING_TOO_DEEP"],
  ])("rejects %s, saves nothing and spends no LLM call", async (_, body, status, code) => {
    const res = await create(body);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(await taskCount()).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("points details.path at the bad node", async () => {
    const res = await create({
      title: "root",
      subtasks: [{ title: "ok" }, { title: "parent", subtasks: [{ title: "bad", skillIds: [SKILL.Frontend], assigneeId: DEV.Dave }] }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ path: [1, 0] });

    const empty = await create({ title: "root", subtasks: [{ title: "ok" }, { title: "" }] });
    expect(empty.json().error.details).toEqual({ path: [1] });

    // The index inside skillIds is not a subtask index.
    const badSkill = await create({ title: "r", subtasks: [{ title: "a", skillIds: [SKILL.Frontend, "x"] }] });
    expect(badSkill.json().error.details).toEqual({ path: [0] });
  });

  it("accepts ids in uppercase", async () => {
    const t = await createOk({ title: "a", skillIds: [SKILL.Backend.toUpperCase(), SKILL.Backend] });
    expect(t.skills).toEqual([{ id: SKILL.Backend, name: "Backend" }]);
    expect((await app.inject(`/api/tasks/${t.id.toUpperCase()}`)).json().id).toBe(t.id);
    const res = await put(t.id.toUpperCase(), "assignee", { developerId: DEV.Bob.toUpperCase() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, assignee: { id: DEV.Bob } });
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("boom"))],
    ["throws synchronously", () => {
      throw new Error("boom");
    }],
  ])("saves as FAILED when the identifier %s", async (_, identify) => {
    await app.close();
    app = buildApp({ pool: db.pool, identifier: { identify } });
    const t = await createOk({ title: "Responsive homepage" });
    expect(t).toMatchObject({ skillSource: "FAILED", skills: [] });
  });

  it("rolls back the whole tree when an insert fails inside the transaction", async () => {
    // The identifier runs after validation and before the transaction, so removing the Frontend skill
    // there makes the task_skill insert fail after the task rows went in.
    const restore = async () => {
      await db.pool.query("INSERT INTO skill (id, name) VALUES ($1, 'Frontend') ON CONFLICT DO NOTHING", [SKILL.Frontend]);
      await db.pool.query(
        "INSERT INTO developer_skill VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING",
        [DEV.Alice, DEV.Carol, SKILL.Frontend],
      );
    };
    await app.close();
    app = buildApp({
      pool: db.pool,
      identifier: {
        identify: async (titles) => {
          await db.pool.query("DELETE FROM developer_skill WHERE skill_id = $1", [SKILL.Frontend]);
          await db.pool.query("DELETE FROM skill WHERE id = $1", [SKILL.Frontend]);
          return titles.map(() => null);
        },
      },
    });
    try {
      const res = await create({ title: "root", skillIds: [SKILL.Frontend], subtasks: [{ title: "needs llm" }] });
      expect(res.statusCode).toBe(500);
      expect(await taskCount()).toBe(0);
    } finally {
      await restore();
    }
  });

  it("accepts 50 tasks in one tree and rejects 51", async () => {
    const tree = (n: number) => ({ title: "root", skillIds: [SKILL.Backend], subtasks: Array.from({ length: n - 1 }, (_, i) => ({ title: `s${i}`, skillIds: [SKILL.Backend] })) });
    const ok = await createOk(tree(50));
    expect(ok.subtasks.map((s) => s.title)).toEqual(Array.from({ length: 49 }, (_, i) => `s${i}`));
    const res = await create(tree(51));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("TREE_TOO_LARGE");
  });

  it("rejects a body over 64 KiB with 413", async () => {
    const res = await create({ title: "a", pad: "x".repeat(65 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("PUT /api/tasks/:id/status", () => {
  async function tree() {
    // Profile update → Avatar UI → Crop tool, all with user skills.
    return createOk({
      title: "Profile update",
      skillIds: [SKILL.Frontend],
      subtasks: [{ title: "Avatar UI", skillIds: [SKILL.Frontend], subtasks: [{ title: "Crop tool", skillIds: [SKILL.Frontend] }] }],
    });
  }

  it("rejects Done while a direct subtask is not Done", async () => {
    const t = await tree();
    const res = await put(t.id, "status", { status: "DONE" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "SUBTASKS_NOT_DONE", details: { unfinished: ["Avatar UI"] } });
  });

  it("allows Done bottom-up, and reopening a leaf resets every Done ancestor", async () => {
    const t = await tree();
    const avatar = t.subtasks[0]!;
    const crop = avatar.subtasks[0]!;
    for (const id of [crop.id, avatar.id, t.id]) expect((await put(id, "status", { status: "DONE" })).statusCode).toBe(200);

    const res = await put(crop.id, "status", { status: "TODO" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task).toMatchObject({ id: crop.id, status: "TODO" });
    expect(body.reopened).toEqual([
      { id: avatar.id, title: "Avatar UI", status: "IN_PROGRESS" },
      { id: t.id, title: "Profile update", status: "IN_PROGRESS" },
    ]);
    const after = (await app.inject(`/api/tasks/${t.id}`)).json();
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.subtasks[0].status).toBe("IN_PROGRESS");
  });

  it("changes any other status freely", async () => {
    const t = await tree();
    const res = await put(t.id, "status", { status: "BLOCKED" });
    expect(res.json()).toMatchObject({ task: { status: "BLOCKED" }, reopened: [] });
  });

  it("rejects an unknown status and an unknown task", async () => {
    const t = await tree();
    expect((await put(t.id, "status", { status: "Done" })).json().error.code).toBe("VALIDATION_ERROR");
    const missing = await put(MISSING_ID, "status", { status: "DONE" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("TASK_NOT_FOUND");
  });
});

describe("PUT /api/tasks/:id/assignee", () => {
  it("assigns a developer with every skill, and unassigns", async () => {
    const t = await createOk({ title: "full stack", skillIds: [SKILL.Frontend, SKILL.Backend] });
    const res = await put(t.id, "assignee", { developerId: DEV.Carol });
    expect(res.json().assignee).toEqual({ id: DEV.Carol, name: "Carol" });
    expect((await put(t.id, "assignee", { developerId: null })).json().assignee).toBeNull();
  });

  it("rejects a developer missing a skill", async () => {
    const t = await createOk({ title: "full stack", skillIds: [SKILL.Frontend, SKILL.Backend] });
    const res = await put(t.id, "assignee", { developerId: DEV.Alice });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ASSIGNEE_LACKS_SKILLS");
  });

  it("rejects assigning a task with no skills", async () => {
    const t = await createOk({ title: "Write onboarding docs" });
    const res = await put(t.id, "assignee", { developerId: DEV.Carol });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TASK_HAS_NO_SKILLS");
  });

  it("rejects an unknown developer with 400 and an unknown task with 404", async () => {
    const t = await createOk({ title: "a", skillIds: [SKILL.Backend] });
    expect((await put(t.id, "assignee", { developerId: MISSING_ID })).statusCode).toBe(400);
    expect((await put(MISSING_ID, "assignee", { developerId: DEV.Bob })).statusCode).toBe(404);
  });
});

describe("PUT /api/tasks/:id/skills", () => {
  async function assignedToAlice() {
    return createOk({ title: "Avatar UI", skillIds: [SKILL.Frontend], assigneeId: DEV.Alice });
  }

  it("rejects an edit that breaks the assignment, naming the assignee and missing skills", async () => {
    const t = await assignedToAlice();
    const res = await put(t.id, "skills", { skillIds: [SKILL.Frontend, SKILL.Backend] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "SKILL_EDIT_BREAKS_ASSIGNMENT",
      details: { assignee: { id: DEV.Alice, name: "Alice" }, missingSkills: ["Backend"] },
    });
    const unchanged = (await app.inject(`/api/tasks/${t.id}`)).json();
    expect(unchanged.skills.map((s: { name: string }) => s.name)).toEqual(["Frontend"]);
    expect(unchanged.assignee.name).toBe("Alice");
  });

  it("saves and unassigns with the flag", async () => {
    const t = await assignedToAlice();
    const res = await put(t.id, "skills", { skillIds: [SKILL.Backend], unassignIfUnqualified: true });
    expect(res.json()).toMatchObject({ skillSource: "USER", assignee: null, skills: [{ name: "Backend" }] });
  });

  it("ignores the flag when the assignee still qualifies", async () => {
    const t = await assignedToAlice();
    const res = await put(t.id, "skills", { skillIds: [SKILL.Frontend, SKILL.Frontend], unassignIfUnqualified: true });
    expect(res.json()).toMatchObject({ assignee: { name: "Alice" }, skills: [{ name: "Frontend" }] });
  });

  it("classifies a FAILED task as USER", async () => {
    const t = await createOk({ title: "Write onboarding docs" });
    const res = await put(t.id, "skills", { skillIds: [SKILL.Backend] });
    expect(res.json()).toMatchObject({ skillSource: "USER", skills: [{ name: "Backend" }] });
  });

  it("rejects an unknown task with 404", async () => {
    const res = await put(MISSING_ID, "skills", { skillIds: [SKILL.Backend] });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("TASK_NOT_FOUND");
  });

  it("rejects an empty list and an unknown skill", async () => {
    const t = await assignedToAlice();
    expect((await put(t.id, "skills", { skillIds: [] })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await put(t.id, "skills", { skillIds: [MISSING_ID] })).json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("tree lock", () => {
  // A parent with one Done child. "parent → Done" and "child → To-do" touch different rows, so only the
  // root lock serialises them; without it, the parent could end Done above an unfinished child.
  it("serialises writes in one tree on the root lock", async () => {
    const t = await createOk({ title: "parent", skillIds: [SKILL.Backend], subtasks: [{ title: "child", skillIds: [SKILL.Backend] }] });
    const child = t.subtasks[0]!;
    expect((await put(child.id, "status", { status: "DONE" })).statusCode).toBe(200);

    const locker = await db.newClient();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM task WHERE id = $1 FOR UPDATE", [t.id]);

    const parentDone = put(t.id, "status", { status: "DONE" });
    const childReopen = put(child.id, "status", { status: "TODO" });

    // Both requests must be blocked on a lock before the locker lets go.
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      const res = await db.pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
        [db.schema],
      );
      waiting = res.rows[0].n;
      if (waiting < 2) await new Promise((r) => setTimeout(r, 20));
    }
    expect(waiting).toBe(2);

    await locker.query("COMMIT");
    await locker.end();
    await Promise.all([parentDone, childReopen]);

    const after = (await app.inject(`/api/tasks/${t.id}`)).json();
    const parentStatus = after.status;
    const childStatus = after.subtasks[0].status;
    expect(parentStatus === "DONE" && childStatus !== "DONE").toBe(false);
  });
});

describe("developer lock", () => {
  // A skill edit that commits while an assignment waits on the developer lock must be seen by that
  // assignment. Reading the skills in the locking statement would return the pre-wait skills instead.
  it("checks the skills as they are after the lock wait", async () => {
    const t = await createOk({ title: "Avatar UI", skillIds: [SKILL.Frontend] });
    const editor = await db.newClient();
    try {
      await editor.query("BEGIN");
      await editor.query("SELECT id FROM developer WHERE id = $1 FOR UPDATE", [DEV.Alice]);
      const assign = put(t.id, "assignee", { developerId: DEV.Alice });

      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 1; i++) {
        const res = await db.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [db.schema],
        );
        waiting = res.rows[0].n;
        if (waiting < 1) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(1);

      await editor.query("DELETE FROM developer_skill WHERE developer_id = $1 AND skill_id = $2", [DEV.Alice, SKILL.Frontend]);
      await editor.query("COMMIT");
      const res = await assign;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ASSIGNEE_LACKS_SKILLS");
    } finally {
      // Close first: if the editor's transaction aborted, a query on it would throw and hide the real error.
      await editor.end();
      await db.pool.query("INSERT INTO developer_skill VALUES ($1, $2) ON CONFLICT DO NOTHING", [DEV.Alice, SKILL.Frontend]);
    }
  });
});
