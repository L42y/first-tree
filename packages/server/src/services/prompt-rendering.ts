import type { EffectiveResourceRow } from "@first-tree/shared";

export type PromptRenderInput = {
  name: string;
  source: EffectiveResourceRow["source"];
  body: string;
  replacesResourceId?: string | null;
};

export function renderPromptRow(input: PromptRenderInput): string {
  const title =
    input.source === "inline_prompt"
      ? input.replacesResourceId
        ? `Agent Prompt Override: ${input.name}`
        : "Agent Prompt (this agent only)"
      : input.source === "agent_extra"
        ? `Agent Prompt Override: ${input.name}`
        : input.source === "agent_template"
          ? `Agent Template: ${input.name}`
          : `Team Prompt: ${input.name}`;
  return `\n\n## ${title}\n\n${input.body.trim()}\n`;
}
