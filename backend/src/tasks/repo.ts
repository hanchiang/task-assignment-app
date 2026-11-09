// SQL for tasks: tree reads, and the inserts and updates the service runs under its locks.
import type pg from "pg";
import type { Queryable, TxClient } from "../db.js";
import type { Skill } from "../skills/repo.js";
import type { TaskNode } from "./schemas.js";
import type { SkillSource, Status } from "./rules.js";

type TaskReadRow = {
  id: string;
  title: string;
  status: Status;
  skill_source: SkillSource;
  parent_id: string | null;
  position: number;
  assignee_id: string | null;
  assignee_name: string | null;
  skills: Skill[];
};

// One statement per read, so a tree comes from one snapshot. $1 is any task id in the tree, or NULL for
// every tree. Rows are ordered by id, which orders roots by creation time; buildForest orders subtasks.
const TREE_SQL = `
  SELECT t.id, t.title, t.status, t.skill_source, t.parent_id, t.position, t.assignee_id,
         d.name AS assignee_name,
         COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                  FILTER (WHERE s.id IS NOT NULL), '[]') AS skills
  FROM task t
  LEFT JOIN developer d ON d.id = t.assignee_id
  LEFT JOIN task_skill ts ON ts.task_id = t.id
  LEFT JOIN skill s ON s.id = ts.skill_id
  WHERE $1::uuid IS NULL OR t.root_id = (SELECT root_id FROM task WHERE id = $1)
  GROUP BY t.id, d.id
  ORDER BY t.id`;

// Nests rows into trees, computes 1-based depth, and orders subtasks by position.
function buildForest(rows: TaskReadRow[]): { roots: TaskNode[]; byId: Map<string, TaskNode> } {
  const byId = new Map<string, TaskNode>();
  const position = new Map<string, number>();
  for (const r of rows) {
    position.set(r.id, r.position);
    byId.set(r.id, {
      id: r.id,
      title: r.title,
      status: r.status,
      parentId: r.parent_id,
      depth: 1,
      skills: r.skills,
      skillSource: r.skill_source,
      assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name! } : null,
      subtasks: [],
    });
  }
  const roots: TaskNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.subtasks.push(node);
    else roots.push(node);
  }
  const finish = (node: TaskNode, depth: number) => {
    node.depth = depth;
    node.subtasks.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    node.subtasks.forEach((c) => finish(c, depth + 1));
  };
  roots.forEach((r) => finish(r, 1));
  return { roots, byId };
}

export async function listTrees(db: Queryable): Promise<TaskNode[]> {
  const res = await db.query<TaskReadRow>(TREE_SQL, [null]);
  return buildForest(res.rows).roots;
}

// Reads the whole tree by root_id and cuts out the subtree in memory, so depth stays absolute.
export async function getSubtree(db: Queryable, taskId: string): Promise<TaskNode | undefined> {
  const res = await db.query<TaskReadRow>(TREE_SQL, [taskId]);
  return buildForest(res.rows).byId.get(taskId);
}

export async function treeStatuses(client: pg.PoolClient, rootId: string) {
  const res = await client.query<{ id: string; title: string; parent_id: string | null; status: Status }>(
    "SELECT id, title, parent_id, status FROM task WHERE root_id = $1",
    [rootId],
  );
  return new Map(res.rows.map((r) => [r.id, r]));
}

export async function directSubtasks(client: pg.PoolClient, taskId: string) {
  const res = await client.query<{ title: string; status: Status }>(
    "SELECT title, status FROM task WHERE parent_id = $1 ORDER BY position",
    [taskId],
  );
  return res.rows;
}

export async function taskSkills(client: pg.PoolClient, taskId: string): Promise<Skill[]> {
  const res = await client.query<Skill>(
    `SELECT s.id, s.name FROM task_skill ts JOIN skill s ON s.id = ts.skill_id
     WHERE ts.task_id = $1 ORDER BY s.name`,
    [taskId],
  );
  return res.rows;
}

export async function setStatus(client: TxClient, ids: string[], status: Status): Promise<void> {
  await client.query("UPDATE task SET status = $2 WHERE id = ANY($1::uuid[])", [ids, status]);
}

export async function setAssignee(client: TxClient, taskId: string, developerId: string | null): Promise<void> {
  await client.query("UPDATE task SET assignee_id = $2 WHERE id = $1", [taskId, developerId]);
}

// Returns the skill ids the task had before, for the change log.
export async function replaceSkills(
  client: TxClient,
  taskId: string,
  skillIds: string[],
  clearAssignee: boolean,
): Promise<string[]> {
  const old = await client.query<{ skill_id: string }>("DELETE FROM task_skill WHERE task_id = $1 RETURNING skill_id", [taskId]);
  await client.query(
    "INSERT INTO task_skill (task_id, skill_id) SELECT $1, unnest($2::uuid[])",
    [taskId, skillIds],
  );
  await client.query(
    `UPDATE task SET skill_source = 'USER', assignee_id = CASE WHEN $2 THEN NULL ELSE assignee_id END WHERE id = $1`,
    [taskId, clearAssignee],
  );
  return old.rows.map((r) => r.skill_id);
}

export type InsertRow = {
  id: string;
  title: string;
  skillSource: SkillSource;
  parentId: string | null;
  rootId: string;
  position: number;
  assigneeId: string | null;
  skillIds: string[];
};

// The whole tree in one INSERT, rows in any order: PostgreSQL checks the parent_id and root_id foreign keys at the end
// of the statement, so a child may come before its parent. Then one INSERT for every task_skill row.
// Both pass one array per column; unnest turns the arrays back into rows, the nth element of each forming row n.
export async function insertTree(client: TxClient, rows: InsertRow[]): Promise<void> {
  await client.query(
    `INSERT INTO task (id, title, skill_source, parent_id, root_id, position, assignee_id)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::smallint[], $7::uuid[])`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.title),
      rows.map((r) => r.skillSource),
      rows.map((r) => r.parentId),
      rows.map((r) => r.rootId),
      rows.map((r) => r.position),
      rows.map((r) => r.assigneeId),
    ],
  );
  const taskIds = rows.flatMap((r) => r.skillIds.map(() => r.id));
  const skillIds = rows.flatMap((r) => r.skillIds);
  if (skillIds.length > 0) {
    await client.query(
      "INSERT INTO task_skill (task_id, skill_id) SELECT * FROM unnest($1::uuid[], $2::uuid[])",
      [taskIds, skillIds],
    );
  }
}
