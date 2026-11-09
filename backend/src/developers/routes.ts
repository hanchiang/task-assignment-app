// HTTP routes for developers (read-only).
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { notFound } from "../errors.js";
import { IdParams, parse } from "../validation.js";
import { getDeveloper, listDevelopers } from "./repo.js";

export function developerRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/developers", async () => listDevelopers(pool));

  app.get("/api/developers/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "developer id");
    const developer = await getDeveloper(pool, id);
    if (!developer) throw notFound("DEVELOPER_NOT_FOUND", `Developer ${id} does not exist.`);
    return developer;
  });
}
