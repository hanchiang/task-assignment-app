// Test double for SkillIdentifier: answers from a fixed title → skills table and records each call.
import type { SkillIdentifier } from "./skillIdentifier.js";

export class FakeSkillIdentifier implements SkillIdentifier {
  readonly calls: string[][] = [];

  constructor(private readonly answers: Record<string, string[] | null> = {}) {}

  async identify(titles: string[]): Promise<(string[] | null)[]> {
    this.calls.push(titles);
    return titles.map((t) => this.answers[t] ?? null);
  }
}
