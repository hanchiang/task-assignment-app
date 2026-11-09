// Parses and validates environment variables once at startup; the rest of the app reads Config.
import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Empty means no key: every identification fails at once and tasks save as FAILED.
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  // Capped so both attempts together (2 × 25 000 ms) finish inside nginx's proxy_read_timeout
  // (frontend/nginx.conf); test/config.test.ts checks this. prefault, unlike default, runs the
  // default through max(), so a default above the cap also fails at startup.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(25_000).prefault(20_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
