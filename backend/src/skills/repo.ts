// SQL for skills. Every list is ordered by name (docs/design.md → API contract).
import type { Queryable } from "../db.js";

export type Skill = { id: string; name: string };

export async function listSkills(db: Queryable): Promise<Skill[]> {
  return (await db.query<Skill>("SELECT id, name FROM skill ORDER BY name")).rows;
}

// The skills among `ids` that exist; a shorter result means some ids are unknown.
export async function findSkills(db: Queryable, ids: string[]): Promise<Skill[]> {
  return (await db.query<Skill>("SELECT id, name FROM skill WHERE id = ANY($1::uuid[]) ORDER BY name", [ids])).rows;
}
