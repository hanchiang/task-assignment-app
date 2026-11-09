// One error type for every rule and input failure, and the Fastify handler that turns it into ErrorBody.
// See docs/design.md → API contract: a 400 is invalid input, a 409 breaks a rule on the stored task.
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(code, 400, message, details);

export const validationError = (message: string, details?: unknown) => badRequest("VALIDATION_ERROR", message, details);

export const notFound = (code: string, message: string) => new AppError(code, 404, message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(code, 409, message, details);

function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  const error: Record<string, unknown> = { code, message, requestId: req.id };
  if (details !== undefined) error.details = details;
  return reply.status(status).send({ error });
}

export function errorHandler(err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as { id?: unknown } | undefined;
  // The route's :id (task, developer or skill; the request log names the route), lowercased to match
  // the ids in write logs (validation.ts lowercases every parsed id).
  const id = typeof params?.id === "string" ? params.id.toLowerCase() : undefined;
  if (err instanceof AppError) {
    req.log.info({ code: err.code, id }, "request rejected by a rule");
    return send(reply, req, err.httpStatus, err.code, err.message, err.details);
  }
  // Fastify's own 4xx errors: body too large (413), malformed JSON, wrong content type.
  const status = (err as FastifyError).statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR";
    req.log.info({ code }, "request rejected");
    return send(reply, req, status, code, err.message);
  }
  req.log.error({ err }, "unexpected error");
  return send(reply, req, 500, "INTERNAL_ERROR", "Something went wrong.");
}
