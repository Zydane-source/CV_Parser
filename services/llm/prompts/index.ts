import * as v1 from "./v1";

export interface PromptDefinition {
  version: string;
  system: string;
  template: string;
}

const PROMPTS: Record<string, PromptDefinition> = {
  v1: { version: v1.PROMPT_VERSION, system: v1.SYSTEM_PROMPT, template: v1.EXTRACTION_PROMPT },
};

export function getPrompt(version: string): PromptDefinition {
  const p = PROMPTS[version];
  if (!p) throw new Error(`Unknown prompt version "${version}". Available: ${Object.keys(PROMPTS).join(", ")}`);
  return p;
}

export function renderPrompt(def: PromptDefinition, cvText: string): string {
  return def.template.replace("{{CV_TEXT}}", cvText);
}

export const availablePromptVersions = () => Object.keys(PROMPTS);
