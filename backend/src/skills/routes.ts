// HTTP routes for skills (read-only).
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { notFound } from "../errors.js";
import { IdParams, parse } from "../validation.js";
import { findSkills, listSkills } from "./repo.js";

export function skillRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/skills", async () => listSkills(pool));

  app.get("/api/skills/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "skill id");
    const [skill] = await findSkills(pool, [id]);
    if (!skill) throw notFound("SKILL_NOT_FOUND", `Skill ${id} does not exist.`);
    return skill;
  });
}
