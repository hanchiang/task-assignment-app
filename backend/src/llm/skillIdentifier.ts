// The seam between task creation and the LLM. One call per Save carries every skill-less title.
// Implemented by unavailableIdentifier (below), the test fake (fake.ts), and the Gemini adapter (gemini.ts).
// See docs/design.md → LLM integration.

type LogFn = (fields: object, msg: string) => void;
export type LlmLogger = { info: LogFn; warn: LogFn; error: LogFn };

export interface SkillIdentifier {
  // Returns one entry per title, in the same order: the skill names identified, or null when that title
  // failed. A rejection means every title failed; TaskService then saves them as FAILED, never failing a Save.
  // `log` is the caller's request logger, so each attempt's log line carries that Save's request id.
  identify(titles: string[], log: LlmLogger): Promise<(string[] | null)[]>;
}

// Used when no API key is configured: every identification fails at once, so tasks save as FAILED.
export const unavailableIdentifier: SkillIdentifier = {
  async identify(titles) {
    return titles.map(() => null);
  },
};
