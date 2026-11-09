// Startup check that the skill names the prompt allows are exactly the names in the skill table.
import type { Queryable } from "../db.js";
import { listSkills } from "../skills/repo.js";
import prompt from "./prompt.json" with { type: "json" };

const skillsSchema = prompt.generationConfig.responseJsonSchema.properties.results.items.properties.skills;
export const PROMPT_SKILL_NAMES: string[] = skillsSchema.items.enum;

export type SkillCheck = {
  ok: boolean;
  promptSkills: string[];
  dbSkills: string[];
  // Allowed by the prompt but with no skill row: the model could name a skill the app cannot save.
  notInDatabase: string[];
  // Skill rows the prompt never offers: the model could never pick them.
  notInPrompt: string[];
};

export function checkPromptSkills(promptSkills: string[], dbSkills: string[]): SkillCheck {
  const inPrompt = new Set(promptSkills);
  const inDatabase = new Set(dbSkills);
  const notInDatabase = promptSkills.filter((name) => !inDatabase.has(name));
  const notInPrompt = dbSkills.filter((name) => !inPrompt.has(name));
  return {
    ok: notInDatabase.length === 0 && notInPrompt.length === 0,
    promptSkills: [...promptSkills].sort(),
    dbSkills: [...dbSkills].sort(),
    notInDatabase: notInDatabase.sort(),
    notInPrompt: notInPrompt.sort(),
  };
}

export class PromptSkillMismatch extends Error {
  constructor(readonly check: SkillCheck) {
    super("prompt.json skill enum does not match the skill table");
  }
}

// Reads the skill table and throws PromptSkillMismatch when it differs from the prompt's enum.
// A database error propagates unchanged, so the caller can tell the two failures apart.
export async function assertPromptMatchesSkills(db: Queryable): Promise<void> {
  const skills = await listSkills(db);
  const check = checkPromptSkills(PROMPT_SKILL_NAMES, skills.map((s) => s.name));
  if (!check.ok) throw new PromptSkillMismatch(check);
}
