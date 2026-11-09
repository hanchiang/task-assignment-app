// LLM handling: the Gemini adapter against hand-written replies and a stubbed fetch (no network), and the
// startup skill check. Cases follow docs/design.md → Testing, LLM handling row.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDailyCounter, createGeminiIdentifier, ErrorBodySchema, ReplySchema } from "../src/llm/gemini.js";
import prompt from "../src/llm/prompt.json" with { type: "json" };
import { assertPromptMatchesSkills, checkPromptSkills, PromptSkillMismatch } from "../src/llm/skillCheck.js";
import type { LlmLogger } from "../src/llm/skillIdentifier.js";
import { createTestDb, type TestDb } from "./db.js";

const API_KEY = "test-key-AIzaSyNotARealKeyNotARealKeyNotAReal1";
const MODEL = "test-model";
const TITLES = ["Avatar UI", "Audit logs", "Lunch order"];

// --- stubs -----------------------------------------------------------------------------------------

type Step = (init: RequestInit) => Promise<Response>;
// startedAt and endedAt are performance.now() times around the stubbed step.
type Call = { url: string; init: RequestInit; startedAt: number; endedAt?: number };

function scriptedFetch(...steps: Step[]) {
  const calls: Call[] = [];
  const stub = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), init, startedAt: performance.now() };
    calls.push(call);
    const step = steps[calls.length - 1] ?? steps[steps.length - 1]!;
    try {
      return await step(init);
    } finally {
      call.endedAt = performance.now();
    }
  };
  return { fetch: stub as typeof fetch, calls };
}

const json = (status: number, body: unknown): Step => async () => new Response(JSON.stringify(body), { status });
const rawText = (status: number, text: string): Step => async () => new Response(text, { status });
const networkError: Step = async () => {
  throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
};
// Like real fetch, rejects with the signal's reason once the time limit passes.
const hangsUntilAborted: Step = (init) =>
  new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
// Headers arrive in time, the body never finishes.
const stalledBody: Step = async (init) => {
  const body = new ReadableStream({
    start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
    },
  });
  return new Response(body, { status: 200 });
};

type LogEntry = { level: keyof LlmLogger; fields: Record<string, unknown>; msg: string };

function capturedLog() {
  const entries: LogEntry[] = [];
  const at = (level: keyof LlmLogger) => (fields: object, msg: string) =>
    entries.push({ level, fields: fields as Record<string, unknown>, msg });
  const log: LlmLogger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { log, entries };
}

function setup(steps: Step[], timeoutMs = 1000) {
  const { fetch, calls } = scriptedFetch(...steps);
  const { log, entries } = capturedLog();
  const identifier = createGeminiIdentifier({ apiKey: API_KEY, model: MODEL, timeoutMs, fetch });
  const run = (titles: string[] = TITLES) => identifier.identify(titles, log);
  return { run, calls, entries };
}

// --- hand-written replies --------------------------------------------------------------------------

function replyWithText(text: string, finishReason = "STOP") {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 0, totalTokenCount: 150 },
  };
}
const replyWithResults = (results: unknown) => replyWithText(JSON.stringify({ results }));
const SUCCESS = replyWithResults([
  { index: 0, skills: ["Frontend"] },
  { index: 1, skills: ["Backend"] },
  { index: 2, skills: [] },
]);
const NO_ANSWERS: (string[] | null)[] = [null, null, null];

// --- request shape ---------------------------------------------------------------------------------

describe("gemini request", () => {
  it("posts to generateContent with the key in a header and the prompt file unchanged", async () => {
    const { run, calls } = setup([json(200, SUCCESS)]);
    await run();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
    expect(url).not.toContain(API_KEY);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": API_KEY });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: prompt.systemInstruction }] });
    expect(body.generationConfig).toEqual(prompt.generationConfig);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: JSON.stringify(TITLES) }] }]);
  });
});

// --- per-item mapping ------------------------------------------------------------------------------

describe("gemini result mapping", () => {
  const identifyWith = async (results: unknown) => {
    const { run, calls } = setup([json(200, replyWithResults(results))]);
    const answers = await run();
    expect(calls).toHaveLength(1);
    return answers;
  };

  it("matches results to titles by index, whatever their order", async () => {
    const answers = await identifyWith([
      { index: 2, skills: ["Backend", "Frontend"] },
      { index: 0, skills: ["Frontend"] },
      { index: 1, skills: ["Backend"] },
    ]);
    expect(answers).toEqual([["Frontend"], ["Backend"], ["Backend", "Frontend"]]);
  });

  it("passes unknown skill names through for the service to drop", async () => {
    const answers = await identifyWith([
      { index: 0, skills: ["Design", "Frontend"] },
      { index: 1, skills: ["Ops"] },
      { index: 2, skills: [] },
    ]);
    expect(answers).toEqual([["Design", "Frontend"], ["Ops"], []]);
  });

  it("returns an empty skills list as empty, not as a failure", async () => {
    const answers = await identifyWith([{ index: 0, skills: [] }]);
    expect(answers[0]).toEqual([]);
  });

  it("gives null to a title whose index is missing", async () => {
    const answers = await identifyWith([{ index: 0, skills: ["Frontend"] }]);
    expect(answers).toEqual([["Frontend"], null, null]);
  });

  it("gives null to a title whose index appears twice, and keeps the others", async () => {
    const answers = await identifyWith([
      { index: 0, skills: ["Frontend"] },
      { index: 0, skills: ["Backend"] },
      { index: 1, skills: ["Backend"] },
    ]);
    expect(answers).toEqual([null, ["Backend"], null]);
  });

  it("ignores items with an out-of-range index", async () => {
    const answers = await identifyWith([
      { index: 3, skills: ["Frontend"] },
      { index: -1, skills: ["Frontend"] },
      { index: 1, skills: ["Backend"] },
    ]);
    expect(answers).toEqual([null, ["Backend"], null]);
  });

  it("ignores items that fail validation, and does not count them as duplicates", async () => {
    const answers = await identifyWith([
      { index: 0, skills: "Frontend" },
      { index: "1", skills: ["Backend"] },
      { index: 1.5, skills: ["Backend"] },
      { skills: ["Backend"] },
      "Backend",
      null,
      { index: 0, skills: ["Frontend"] },
    ]);
    expect(answers).toEqual([["Frontend"], null, null]);
  });
});

// --- whole-attempt failures ------------------------------------------------------------------------

describe("gemini whole-attempt failures", () => {
  // Each is retried once, so two identical replies mean every title failed.
  const cases: [string, Step][] = [
    ["a blocked prompt (no candidates)", json(200, { promptFeedback: { blockReason: "SAFETY" } })],
    ["an empty candidates list with no reason", json(200, { candidates: [] })],
    ["finishReason MAX_TOKENS", json(200, replyWithText('{"results":[{"index":0,"skills":["Frontend"]}]}', "MAX_TOKENS"))],
    ["finishReason SAFETY", json(200, replyWithText('{"results":[]}', "SAFETY"))],
    ["a candidate with no finishReason", json(200, { candidates: [{ content: { parts: [{ text: '{"results":[]}' }] } }] })],
    ["answer text that is not JSON", json(200, replyWithText("Frontend, Backend"))],
    ["answer text cut off mid-JSON", json(200, replyWithText('{"results":[{"index":0,'))],
    ["an answer without results", json(200, replyWithText('{"answers":[]}'))],
    ["results that is not an array", json(200, replyWithText('{"results":"none"}'))],
    ["a candidate with no content", json(200, { candidates: [{ finishReason: "STOP" }] })],
    ["a reply body that is not JSON", rawText(200, "<html>bad gateway</html>")],
    ["a reply body of the wrong shape", json(200, { candidates: "none" })],
  ];

  it.each(cases)("fails every title and retries once on %s", async (_name, step) => {
    const { run, calls, entries } = setup([step]);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(2);
    expect(entries.map((e) => e.fields.attempt)).toEqual([1, 2]);
    expect(entries.every((e) => e.level === "warn" && e.fields.outcome !== "ok")).toBe(true);
  });

  it("logs the block reason and the finish reason", async () => {
    const blocked = setup([json(200, { promptFeedback: { blockReason: "SAFETY" } })]);
    await blocked.run();
    expect(blocked.entries[0]!.fields).toMatchObject({ outcome: "blocked", blockReason: "SAFETY" });

    const cutOff = setup([json(200, replyWithText("{}", "MAX_TOKENS"))]);
    await cutOff.run();
    expect(cutOff.entries[0]!.fields).toMatchObject({ outcome: "unfinished", finishReason: "MAX_TOKENS" });
  });

  it("calls a reply with no candidates and no reason no_candidates, not blocked", async () => {
    const { run, entries } = setup([json(200, { candidates: [] })]);
    await run();
    expect(entries[0]!.fields).toMatchObject({ outcome: "no_candidates", blockReason: undefined });
  });

  it("recovers when the retry succeeds", async () => {
    const { run, calls } = setup([json(200, replyWithText("not json")), json(200, SUCCESS)]);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
    expect(calls).toHaveLength(2);
  });
});

// --- timeouts --------------------------------------------------------------------------------------

describe("gemini timeouts", () => {
  it("cuts off a hanging attempt, retries once, then fails every title", async () => {
    const { run, calls, entries } = setup([hangsUntilAborted], 20);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(2);
    expect(entries.map((e) => [e.level, e.fields.outcome])).toEqual([
      ["warn", "timeout"],
      ["warn", "timeout"],
    ]);
  });

  it("succeeds when the retry answers in time", async () => {
    const { run, calls } = setup([hangsUntilAborted, json(200, SUCCESS)], 20);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
    expect(calls).toHaveLength(2);
  });

  it("counts a body that stalls after the headers as a timeout", async () => {
    const { run, entries } = setup([stalledBody, json(200, SUCCESS)], 20);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
    expect(entries[0]!.fields.outcome).toBe("timeout");
  });

  it("retries at once and gives the retry its own full time limit", async () => {
    const timeoutMs = 200;
    const { run, calls } = setup([hangsUntilAborted], timeoutMs);
    await run();

    const [first, second] = calls as [Call, Call];
    expect(first.init.signal).not.toBe(second.init.signal);
    // No backoff: the retry starts within a few ms of the first attempt ending.
    expect(second.startedAt - first.endedAt!).toBeLessThan(50);
    // The retry is cut off about timeoutMs after it starts, not after the first attempt started.
    const secondAttemptMs = second.endedAt! - second.startedAt;
    expect(secondAttemptMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(secondAttemptMs).toBeLessThan(timeoutMs + 100);
  });
});

// --- HTTP errors -----------------------------------------------------------------------------------

describe("gemini HTTP errors", () => {
  const errorBody = (code: number, status: string) => ({ error: { code, status, message: "details" } });

  it.each([400, 401, 403, 404])("does not retry HTTP %i, and logs at error level", async (status) => {
    const { run, calls, entries } = setup([json(status, errorBody(status, "INVALID_ARGUMENT"))]);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.fields).toMatchObject({ outcome: "http_error", httpStatus: status, errorStatus: "INVALID_ARGUMENT" });
  });

  it("retries a 429 once, logging each at warn level", async () => {
    const { run, calls, entries } = setup([json(429, errorBody(429, "RESOURCE_EXHAUSTED"))]);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(2);
    expect(entries.map((e) => e.level)).toEqual(["warn", "warn"]);
    expect(entries[0]!.fields).toMatchObject({ httpStatus: 429, errorStatus: "RESOURCE_EXHAUSTED" });
  });

  it("retries a 500 once", async () => {
    const { run, calls } = setup([json(500, errorBody(500, "INTERNAL"))]);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(2);
  });

  it("succeeds when a retry after 429 answers", async () => {
    const { run, calls } = setup([json(429, errorBody(429, "RESOURCE_EXHAUSTED")), json(200, SUCCESS)]);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
    expect(calls).toHaveLength(2);
  });

  it("succeeds when a retry after 500 answers", async () => {
    const { run } = setup([json(500, errorBody(500, "INTERNAL")), json(200, SUCCESS)]);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
  });

  it("handles an error body that is not JSON", async () => {
    const { run, entries } = setup([rawText(502, "<html>bad gateway</html>")]);
    expect(await run()).toEqual(NO_ANSWERS);
    expect(entries[0]!.fields).toMatchObject({ httpStatus: 502, errorStatus: undefined });
  });

  it("retries a network error once, and resolves instead of rejecting", async () => {
    const { run, calls, entries } = setup([networkError]);
    await expect(run()).resolves.toEqual(NO_ANSWERS);
    expect(calls).toHaveLength(2);
    expect(entries[0]!.fields).toMatchObject({ outcome: "network_error", errorName: "TypeError", errorCode: "ECONNREFUSED" });
  });
});

// --- logging ---------------------------------------------------------------------------------------

describe("gemini logging", () => {
  it("logs a successful attempt at info level with its counts and token usage", async () => {
    const { run, entries } = setup([json(200, SUCCESS)]);
    await run();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.fields).toMatchObject({
      attempt: 1,
      model: MODEL,
      outcome: "ok",
      httpStatus: 200,
      titleCount: 3,
      requestsToday: 1,
      usage: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 0, totalTokenCount: 150 },
    });
    expect(entries[0]!.fields.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("counts every request in requestsToday, retries included, across calls", async () => {
    const { run, entries } = setup([json(500, {}), json(200, SUCCESS), json(200, SUCCESS)]);
    await run();
    await run();
    expect(entries.map((e) => e.fields.requestsToday)).toEqual([1, 2, 3]);
  });

  it("keeps working when usageMetadata is malformed", async () => {
    const reply = { ...SUCCESS, usageMetadata: { promptTokenCount: "many" } };
    const { run, entries } = setup([json(200, reply)]);
    expect(await run()).toEqual([["Frontend"], ["Backend"], []]);
    expect(entries[0]!.fields.usage).toBeUndefined();
  });

  it("never logs a title, the key, or the provider's error message", async () => {
    // The error message echoes a title and the key, as a provider's free text might.
    const leaky = {
      error: { code: 400, status: "INVALID_ARGUMENT", message: `bad request for ${TITLES[0]} key=${API_KEY} projects/123456` },
    };
    const runs = [
      setup([json(200, SUCCESS)]),
      setup([json(400, leaky)]),
      setup([json(429, leaky)]),
      setup([hangsUntilAborted], 20),
      setup([networkError]),
      setup([json(200, replyWithText(`{"results":"${TITLES[1]}"}`))]),
      setup([json(200, { promptFeedback: { blockReason: "SAFETY" } })]),
    ];
    for (const scenario of runs) await scenario.run();

    const logged = JSON.stringify(runs.flatMap((scenario) => scenario.entries));
    expect(logged).toContain("outcome");
    for (const secret of [...TITLES, API_KEY, "projects/123456", "bad request"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("daily request counter", () => {
  it("counts up within a UTC day and restarts at midnight UTC", () => {
    let now = new Date("2026-11-09T23:59:58Z");
    const count = createDailyCounter(() => now);
    expect([count(), count()]).toEqual([1, 2]);
    now = new Date("2026-11-10T00:00:01Z");
    expect([count(), count()]).toEqual([1, 2]);
  });
});

// --- startup skill check ---------------------------------------------------------------------------

describe("startup skill check", () => {
  it("passes when the prompt names and the table names match, in any order", () => {
    const check = checkPromptSkills(["Frontend", "Backend"], ["Backend", "Frontend"]);
    expect(check).toMatchObject({ ok: true, notInDatabase: [], notInPrompt: [] });
  });

  it("fails when the prompt allows a skill the table lacks", () => {
    const check = checkPromptSkills(["Frontend", "Backend", "Design"], ["Frontend", "Backend"]);
    expect(check).toMatchObject({ ok: false, notInDatabase: ["Design"], notInPrompt: [] });
  });

  it("fails when the table has a skill the prompt never offers", () => {
    const check = checkPromptSkills(["Frontend", "Backend"], ["Frontend", "Backend", "Mobile"]);
    expect(check).toMatchObject({ ok: false, notInDatabase: [], notInPrompt: ["Mobile"] });
  });

  it("reports both lists, sorted, so a log line shows the whole mismatch", () => {
    const check = checkPromptSkills(["Frontend", "Backend"], ["Mobile", "Backend"]);
    expect(check).toMatchObject({ promptSkills: ["Backend", "Frontend"], dbSkills: ["Backend", "Mobile"] });
  });

  describe("assertPromptMatchesSkills against the database", () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await createTestDb();
    });
    afterAll(async () => {
      await db.cleanup();
    });

    it("resolves on the skills db/init seeds", async () => {
      await expect(assertPromptMatchesSkills(db.pool)).resolves.toBeUndefined();
    });

    it("rejects with the extra skill when the table has one the prompt lacks", async () => {
      await db.pool.query("INSERT INTO skill (id, name) VALUES ($1, 'Mobile')", [randomUUID()]);
      try {
        const rejection = assertPromptMatchesSkills(db.pool);
        await expect(rejection).rejects.toBeInstanceOf(PromptSkillMismatch);
        await expect(rejection).rejects.toMatchObject({ check: { ok: false, notInPrompt: ["Mobile"], notInDatabase: [] } });
      } finally {
        await db.pool.query("DELETE FROM skill WHERE name = 'Mobile'");
      }
    });

    it("rejects with the missing skill when the table lacks one the prompt allows", async () => {
      await db.pool.query("UPDATE skill SET name = 'Platform' WHERE name = 'Backend'");
      try {
        await expect(assertPromptMatchesSkills(db.pool)).rejects.toMatchObject({
          check: { ok: false, notInDatabase: ["Backend"], notInPrompt: ["Platform"] },
        });
      } finally {
        await db.pool.query("UPDATE skill SET name = 'Backend' WHERE name = 'Platform'");
      }
    });

    it("lets a database error through unchanged, so it is not mistaken for a mismatch", async () => {
      await db.pool.query("ALTER TABLE skill RENAME TO skill_gone");
      try {
        const rejection = assertPromptMatchesSkills(db.pool);
        await expect(rejection).rejects.not.toBeInstanceOf(PromptSkillMismatch);
        await expect(rejection).rejects.toMatchObject({ code: "42P01" });
      } finally {
        await db.pool.query("ALTER TABLE skill_gone RENAME TO skill");
      }
    });
  });
});

// --- response fields vs design.md ------------------------------------------------------------------

type ZodNode = { def: { type: string; shape?: Record<string, ZodNode>; innerType?: ZodNode; element?: ZodNode } };

// The dotted path of every leaf field a zod object schema reads, e.g. "candidates.content.parts.text".
// Optional, default and catch wrappers and array elements add no path segment.
function leafPaths(node: ZodNode, prefix = ""): string[] {
  const { shape, innerType, element } = node.def;
  const inner = innerType ?? element;
  if (inner) return leafPaths(inner, prefix);
  if (!shape) return [prefix];
  return Object.entries(shape).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

const withoutIndexes = (path: string) => path.replaceAll("[0]", "").replaceAll("[]", "");

// Paths from the first column of the "Response fields read" table. A cell may name a parent and then list
// its children in parentheses, as in "`usageMetadata` (`promptTokenCount`, ...)"; each child is parent.child.
function documentedPaths(section: string): Set<string> {
  const rows = section.split("\n").filter((line) => line.startsWith("| `"));
  const paths = rows.flatMap((row) => {
    const firstColumn = row.split("|")[1] ?? "";
    const [parent, ...children] = [...firstColumn.matchAll(/`([^`]+)`/g)].map((m) => withoutIndexes(m[1]!));
    return [parent!, ...children.map((child) => `${parent}.${child}`)];
  });
  return new Set(paths);
}

// The "Response fields read" paragraph and table, up to the next heading.
function responseFieldsSection(design: string): string {
  const start = design.indexOf("Response fields read");
  if (start === -1) return "";
  const nextHeading = design.indexOf("\n#", start);
  return design.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

// The answer and item schemas are not walked: prompt.json's responseJsonSchema fixes their shape.
function undocumentedFields(schemas: ZodNode[], section: string): string[] {
  const documented = documentedPaths(section);
  return schemas.flatMap((schema) => leafPaths(schema)).filter((path) => !documented.has(path)).sort();
}

describe("response fields read are documented", () => {
  const DESIGN_URL = new URL("../../docs/design.md", import.meta.url);
  const REPLY_SCHEMAS = [ReplySchema, ErrorBodySchema] as unknown as ZodNode[];
  const SECTION = `Response fields read
| Field | Used for |
| --- | --- |
| \`candidates[0].content.parts[].text\` | answer |
| \`usageMetadata\` (\`totalTokenCount\`) | counts |
| \`error.status\` (on HTTP errors) | logged; the free-text \`error.message\` is not logged |
`;

  it("names every field gemini.ts reads in design.md → Response fields read, first column", () => {
    const section = responseFieldsSection(readFileSync(DESIGN_URL, "utf8"));
    expect(documentedPaths(section).size).toBeGreaterThan(0);
    expect(undocumentedFields(REPLY_SCHEMAS, section)).toEqual([]);
  });

  it("walks the real schemas to their leaf paths, so an empty walk cannot pass", () => {
    expect(REPLY_SCHEMAS.flatMap((schema) => leafPaths(schema)).sort()).toEqual([
      "candidates.content.parts.text",
      "candidates.finishReason",
      "error.status",
      "promptFeedback.blockReason",
      "usageMetadata.candidatesTokenCount",
      "usageMetadata.promptTokenCount",
      "usageMetadata.thoughtsTokenCount",
      "usageMetadata.totalTokenCount",
    ]);
  });

  it("reads the table's first column, normalising [0] and [], and expanding parenthesised children", () => {
    expect([...documentedPaths(SECTION)].sort()).toEqual([
      "candidates.content.parts.text",
      "error.status",
      "usageMetadata",
      "usageMetadata.totalTokenCount",
    ]);
  });

  it("reports a nested field the table does not name, even if its last word appears elsewhere", () => {
    const withMessage = [z.object({ error: z.object({ status: z.string(), message: z.string() }) })] as unknown as ZodNode[];
    // `error.message` appears in the status row's prose, but not in its first column.
    expect(undocumentedFields(withMessage, SECTION)).toEqual(["error.message"]);
  });

  it("reports a field under a documented name, such as candidates[].index", () => {
    const withIndex = [z.object({ candidates: z.array(z.object({ index: z.number() })) })] as unknown as ZodNode[];
    expect(undocumentedFields(withIndex, SECTION)).toEqual(["candidates.index"]);
  });
});
