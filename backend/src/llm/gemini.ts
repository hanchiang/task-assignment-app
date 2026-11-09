// Gemini adapter for SkillIdentifier: sends the batch, retries, and parses the reply by index. Turning names
// into skills, and choosing LLM or FAILED, happen in tasks/service.ts. Rules and log fields: docs/design.md → LLM integration.
import { z } from "zod";
import prompt from "./prompt.json" with { type: "json" };
import type { LlmLogger, SkillIdentifier } from "./skillIdentifier.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Exported for test/config.test.ts, which keeps MAX_ATTEMPTS × the time-limit cap inside nginx's proxy timeout.
export const MAX_ATTEMPTS = 2;
// The request, key or model id is wrong, so a retry cannot help.
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404]);

export type GeminiOptions = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
};

type Answers = (string[] | null)[];
type Outcome =
  | "ok"
  | "timeout"
  | "network_error"
  | "http_error"
  | "blocked" // no candidates, and the reply says why
  | "no_candidates" // no candidates, and no reason given
  | "unfinished"
  | "bad_reply";

const UsageSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  thoughtsTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
});
type Usage = z.infer<typeof UsageSchema>;

// What one attempt tells the log. Every field is a count, a status code or a provider enum value, never
// free text, so none of it can carry a title, the key or a Cloud project name.
type AttemptDetail = {
  outcome: Outcome;
  httpStatus?: number;
  errorStatus?: string;
  blockReason?: string;
  finishReason?: string;
  errorName?: string;
  errorCode?: string;
  usage?: Usage;
};
type AttemptResult = { ok: true; answers: Answers; detail: AttemptDetail } | { ok: false; detail: AttemptDetail };

// Exported with ErrorBodySchema (below) so llm.test.ts can check that every field they read is named in
// docs/design.md → Response fields read. A new schema for a reply field must be added to that test too.
export const ReplySchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).default([]) }).optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  // Logging detail must never fail an attempt, so a malformed usage block is dropped.
  usageMetadata: UsageSchema.optional().catch(undefined),
});
// Items stay unknown here so one bad item does not fail the whole attempt.
const AnswerSchema = z.object({ results: z.array(z.unknown()) });
const ItemSchema = z.object({ index: z.number().int(), skills: z.array(z.string()) });
export const ErrorBodySchema = z.object({ error: z.object({ status: z.string() }) });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failed(detail: AttemptDetail): AttemptResult {
  return { ok: false, detail };
}

// Maps each item to its title. A repeated index is ambiguous, so that title gets null rather than a guess.
function mapItems(items: unknown[], titleCount: number): Answers {
  const skillsByIndex = new Map<number, string[] | null>();
  for (const raw of items) {
    const item = ItemSchema.safeParse(raw);
    if (!item.success) continue;
    const { index, skills } = item.data;
    if (index < 0 || index >= titleCount) continue;
    skillsByIndex.set(index, skillsByIndex.has(index) ? null : skills);
  }
  return Array.from({ length: titleCount }, (_, i) => skillsByIndex.get(i) ?? null);
}

// Classifies a 2xx body: blocked, unfinished or unreadable fails the attempt; otherwise maps items.
function readReply(text: string, titleCount: number, httpStatus: number): AttemptResult {
  const reply = ReplySchema.safeParse(parseJson(text));
  if (!reply.success) return failed({ outcome: "bad_reply", httpStatus });
  const { candidates, promptFeedback, usageMetadata: usage } = reply.data;
  const replyFields = { httpStatus, usage };

  const candidate = candidates?.[0];
  if (!candidate) {
    const blockReason = promptFeedback?.blockReason;
    return failed({ outcome: blockReason ? "blocked" : "no_candidates", blockReason, ...replyFields });
  }
  if (candidate.finishReason !== "STOP") {
    return failed({ outcome: "unfinished", finishReason: candidate.finishReason, ...replyFields });
  }

  const parts = candidate.content?.parts ?? [];
  const answer = AnswerSchema.safeParse(parseJson(parts.map((p) => p.text ?? "").join("")));
  if (!answer.success) return failed({ outcome: "bad_reply", ...replyFields });
  return { ok: true, answers: mapItems(answer.data.results, titleCount), detail: { outcome: "ok", ...replyFields } };
}

function errorStatusOf(text: string): string | undefined {
  const body = ErrorBodySchema.safeParse(parseJson(text));
  return body.success ? body.data.error.status : undefined;
}

function isConfigError(detail: AttemptDetail): boolean {
  return detail.httpStatus !== undefined && NO_RETRY_STATUSES.has(detail.httpStatus);
}

function levelOf(detail: AttemptDetail): keyof LlmLogger {
  if (detail.outcome === "ok") return "info";
  return isConfigError(detail) ? "error" : "warn";
}

// Counts requests since midnight UTC. Each call counts one request and returns the day's total so far.
// For example, calls at 23:59:58Z and 23:59:59Z return 1 and 2; the next call, at 00:00:01Z, returns 1 again.
export function createDailyCounter(now: () => Date = () => new Date()): () => number {
  let day = "";
  let count = 0;
  return () => {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      count = 0;
    }
    return ++count;
  };
}

export function createGeminiIdentifier(options: GeminiOptions): SkillIdentifier {
  const { apiKey, model, timeoutMs, fetch: doFetch = globalThis.fetch } = options;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const countRequest = createDailyCounter();

  const buildBody = (titles: string[]) => ({
    systemInstruction: { parts: [{ text: prompt.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(titles) }] }],
    generationConfig: prompt.generationConfig,
  });

  async function attempt(titles: string[]): Promise<AttemptResult> {
    // One signal covers the connection and the body read. With timeoutMs 20000, attempt 1 is cut off at
    // t=20s; a retry starts at once and is cut off at t=40s, so identify() waits 40s at most.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(buildBody(titles)),
        signal,
      });
      const text = await res.text();
      if (res.ok) return readReply(text, titles.length, res.status);
      return failed({ outcome: "http_error", httpStatus: res.status, errorStatus: errorStatusOf(text) });
    } catch (err) {
      if (signal.aborted) return failed({ outcome: "timeout" });
      const errorCode = (err as { cause?: { code?: string } }).cause?.code;
      return failed({ outcome: "network_error", errorName: (err as Error)?.name, errorCode });
    }
  }

  return {
    // Never rejects: the per-attempt logs already carry the cause at the right level.
    async identify(titles, log) {
      for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
        const requestsToday = countRequest();
        const started = performance.now();
        const result = await attempt(titles);
        const latencyMs = Math.round(performance.now() - started);
        const fields = { attempt: attemptNumber, model, latencyMs, titleCount: titles.length, requestsToday, ...result.detail };
        log[levelOf(result.detail)](fields, "gemini attempt");
        if (result.ok) return result.answers;
        if (isConfigError(result.detail)) break;
      }
      return titles.map(() => null);
    },
  };
}
