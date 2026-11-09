// Entry point: read config, connect the pool, pick the skill identifier, and listen.
import pg from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { unavailableIdentifier } from "./llm/skillIdentifier.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const app = buildApp({
  pool,
  // The Gemini adapter replaces this when a key is configured (Skill identification task).
  identifier: unavailableIdentifier,
  logger: { level: config.LOG_LEVEL, redact: ["GEMINI_API_KEY", "*.GEMINI_API_KEY"] },
});

// A connection the database drops (e.g. on restart) emits "error"; with no listener, node exits.
// Idle connections report through the pool's event, logged here. A checked-out connection's error also
// fails its running query, and the pool discards that connection on release, so its listener only keeps
// the process alive.
pool.on("connect", (client) => client.on("error", () => {}));
pool.on("error", (err) => app.log.warn({ errorName: err.name, code: (err as { code?: string }).code }, "idle database connection lost"));

app.log.info(
  { port: config.PORT, model: config.GEMINI_MODEL, llmTimeoutMs: config.LLM_TIMEOUT_MS, geminiKeyPresent: config.GEMINI_API_KEY !== "" },
  "starting",
);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });
