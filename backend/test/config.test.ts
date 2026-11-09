// Keeps the worst-case Save wait (attempts × the time-limit cap) inside nginx's proxy timeout. The three values
// live in three files, and a Save that outlasts nginx shows a failure while the task is still being saved.
// It also checks that docker-compose.yml passes the same LLM_TIMEOUT_MS default as config.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MAX_ATTEMPTS } from "../src/llm/gemini.js";

const env = (llmTimeoutMs: string) => ({ DATABASE_URL: "postgres://x", LLM_TIMEOUT_MS: llmTimeoutMs });
const MAX_LLM_TIMEOUT_MS = 25_000;

function nginxProxyReadTimeoutMs(): number {
  const conf = readFileSync(new URL("../../frontend/nginx.conf", import.meta.url), "utf8");
  // Directive lines only, so a commented-out value can't stand in for the real one.
  const matches = [...conf.matchAll(/^\s*proxy_read_timeout\s+(\d+)s;/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected one proxy_read_timeout in frontend/nginx.conf, found ${matches.length}`);
  }
  return Number(matches[0]![1]) * 1000;
}

function composeTimeoutDefaultMs(): number {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  // Matches `LLM_TIMEOUT_MS: ${LLM_TIMEOUT_MS:-<ms>}` and captures the number after `:-`.
  const matches = [...compose.matchAll(/^\s*LLM_TIMEOUT_MS:\s*\$\{LLM_TIMEOUT_MS:-(\d+)\}/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected one LLM_TIMEOUT_MS default in docker-compose.yml, found ${matches.length}`);
  }
  return Number(matches[0]![1]);
}

describe("LLM_TIMEOUT_MS", () => {
  it("accepts the cap and rejects anything above it", () => {
    expect(loadConfig(env(String(MAX_LLM_TIMEOUT_MS))).LLM_TIMEOUT_MS).toBe(MAX_LLM_TIMEOUT_MS);
    expect(() => loadConfig(env(String(MAX_LLM_TIMEOUT_MS + 1)))).toThrow(/LLM_TIMEOUT_MS/);
  });

  it("keeps the worst-case Save wait inside nginx's proxy timeout", () => {
    expect(MAX_ATTEMPTS * MAX_LLM_TIMEOUT_MS).toBeLessThan(nginxProxyReadTimeoutMs());
  });

  // The default lives in config.ts and again in docker-compose.yml; a change to one must reach the other.
  it("has the same default in config.ts and docker-compose.yml", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).LLM_TIMEOUT_MS).toBe(composeTimeoutDefaultMs());
  });
});
