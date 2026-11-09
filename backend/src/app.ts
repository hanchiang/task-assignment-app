// Builds the Fastify instance with every route. server.ts listens on it; tests call app.inject without a port.
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";
import limits from "./limits.json" with { type: "json" };
import { errorHandler, notFound } from "./errors.js";
import { developerRoutes } from "./developers/routes.js";
import type { SkillIdentifier } from "./llm/skillIdentifier.js";
import { skillRoutes } from "./skills/routes.js";
import { STATUSES } from "./tasks/rules.js";
import { taskRoutes } from "./tasks/routes.js";
import { TaskService } from "./tasks/service.js";

export type AppDeps = {
  pool: pg.Pool;
  identifier: SkillIdentifier;
  logger?: FastifyServerOptions["logger"];
};

export function buildApp({ pool, identifier, logger = false }: AppDeps) {
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024, // bounds every input below, including how deeply a body can nest
    genReqId: () => randomUUID(),
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    errorHandler(notFound("NOT_FOUND", `No route ${req.method} ${req.url}.`), req, reply);
  });

  const service = new TaskService({ pool, identifier });
  taskRoutes(app, pool, service);
  developerRoutes(app, pool);
  skillRoutes(app, pool);

  app.get("/api/meta", async () => ({ ...limits, statuses: STATUSES }));

  app.get("/api/health", async (req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, "health check: database did not answer");
      return reply.status(503).send({ ok: false });
    }
  });

  return app;
}
