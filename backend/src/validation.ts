// Input validation shared by every feature's routes: the id format and the zod-to-VALIDATION_ERROR bridge.
import { z } from "zod";
import { validationError } from "./errors.js";

// Lowercased once here: PostgreSQL returns ids in lowercase, and the services compare ids as strings.
export const Id = z.uuid().transform((s) => s.toLowerCase());
export const IdParams = z.object({ id: Id });

export type IssuePath = readonly PropertyKey[];

// Parses or throws VALIDATION_ERROR naming the first bad field. `details` lets a feature add its own
// pointer to the bad part of the input, such as the create endpoint's subtask path.
export function parse<T>(schema: z.ZodType<T>, data: unknown, label: string, details?: (path: IssuePath) => unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const field = issue.path.join(".") || label;
  throw validationError(`Invalid ${label}: ${field}: ${issue.message}`, details?.(issue.path));
}
