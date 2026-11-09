// HTTP routes for tasks. Each parses its input with zod, then hands off to TaskService or the repo.
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { notFound } from "../errors.js";
import { IdParams, parse } from "../validation.js";
import * as repo from "./repo.js";
import { AssigneeBody, SkillsBody, StatusBody } from "./schemas.js";
import type { TaskService } from "./service.js";

export function taskRoutes(app: FastifyInstance, pool: pg.Pool, service: TaskService) {
  app.get("/api/tasks", async () => repo.listTrees(pool));

  app.get("/api/tasks/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "task id");
    const node = await repo.getSubtree(pool, id);
    if (!node) throw notFound("TASK_NOT_FOUND", `Task ${id} does not exist.`);
    return node;
  });

  app.post("/api/tasks", async (req, reply) => {
    const created = await service.create(req.body, req.log);
    return reply.status(201).send(created);
  });

  app.put("/api/tasks/:id/status", async (req) => {
    const { id } = parse(IdParams, req.params, "task id");
    const { status } = parse(StatusBody, req.body, "status");
    return service.changeStatus(id, status, req.log);
  });

  app.put("/api/tasks/:id/assignee", async (req) => {
    const { id } = parse(IdParams, req.params, "task id");
    const { developerId } = parse(AssigneeBody, req.body, "assignee");
    return service.changeAssignee(id, developerId, req.log);
  });

  app.put("/api/tasks/:id/skills", async (req) => {
    const { id } = parse(IdParams, req.params, "task id");
    const { skillIds, unassignIfUnqualified } = parse(SkillsBody, req.body, "skills");
    return service.changeSkills(id, skillIds, unassignIfUnqualified ?? false, req.log);
  });
}
