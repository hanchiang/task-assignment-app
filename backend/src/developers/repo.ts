// SQL for developers. Nested lists are ordered by name, assigned tasks by id (docs/design.md → API contract).
import type { Queryable } from "../db.js";
import type { Skill } from "../skills/repo.js";
import type { TaskRef } from "../tasks/schemas.js";

export type Developer = { id: string; name: string; skills: Skill[] };

const DEVELOPER_SQL = `
  SELECT d.id, d.name,
         COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                  FILTER (WHERE s.id IS NOT NULL), '[]') AS skills
  FROM developer d
  LEFT JOIN developer_skill ds ON ds.developer_id = d.id
  LEFT JOIN skill s ON s.id = ds.skill_id
  WHERE $1::uuid IS NULL OR d.id = $1
  GROUP BY d.id
  ORDER BY d.name, d.id`;

export async function listDevelopers(db: Queryable): Promise<Developer[]> {
  return (await db.query<Developer>(DEVELOPER_SQL, [null])).rows;
}

export async function getDeveloper(db: Queryable, id: string): Promise<(Developer & { assignedTasks: TaskRef[] }) | undefined> {
  const dev = (await db.query<Developer>(DEVELOPER_SQL, [id])).rows[0];
  if (!dev) return undefined;
  const tasks = await db.query<TaskRef>(
    "SELECT id, title, status FROM task WHERE assignee_id = $1 ORDER BY id",
    [id],
  );
  return { ...dev, assignedTasks: tasks.rows };
}
