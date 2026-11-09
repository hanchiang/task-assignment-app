// Entry point: read config, connect the pool, pick the skill identifier, and listen.
import pg from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createGeminiIdentifier } from "./llm/gemini.js";
import { assertPromptMatchesSkills, PromptSkillMismatch } from "./llm/skillCheck.js";
import { unavailableIdentifier } from "./llm/skillIdentifier.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const identifier =
  config.GEMINI_API_KEY === ""
    ? unavailableIdentifier
    : createGeminiIdentifier({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
      });

const app = buildApp({
  pool,
  identifier,
  logger: { level: config.LOG_LEVEL, redact: ["GEMINI_API_KEY", "*.GEMINI_API_KEY"] },
});

// A connection the database drops (e.g. on restart) emits "error"; with no listener, node exits.
// Idle connections report through the pool's event, logged here. A checked-out connection's error also
// fails its running query, and the pool discards that connection on release, so its listener only keeps
// the process alive.
pool.on("connect", (client) => client.on("error", () => {}));
pool.on("error", (err) => app.log.warn({ errorName: err.name, code: (err as { code?: string }).code }, "idle database connection lost"));

// Logs a startup failure once the logger exists, then exits. An invalid environment fails earlier, in
// loadConfig, as an uncaught error.
function failStartup(fields: object, msg: string): never {
  app.log.error(fields, msg);
  process.exit(1);
}

// Name and code only: an error message can carry connection details.
const errorFields = (err: unknown) => ({ errorName: (err as Error)?.name, code: (err as { code?: string })?.code });

// Checked with or without a key, so a drifted prompt is caught before anyone sets one.
try {
  await assertPromptMatchesSkills(pool);
} catch (err) {
  if (err instanceof PromptSkillMismatch) failStartup(err.check, `${err.message}; refusing to start`);
  failStartup(errorFields(err), "could not read the skill table; refusing to start");
}

app.log.info(
  {
    port: config.PORT,
    model: config.GEMINI_MODEL,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    geminiKeyPresent: config.GEMINI_API_KEY !== "",
    // Always true here: a mismatch exits above, so this line is only reached when the check passed.
    skillEnumMatchesTable: true,
  },
  "starting",
);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch (err) {
  failStartup(errorFields(err), "could not listen; refusing to start");
}
