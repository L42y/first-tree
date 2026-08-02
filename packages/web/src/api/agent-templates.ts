import type { AgentResourcesOutput, AgentTemplatePublicList, UpdateAgentTemplates } from "@first-tree/shared";
import { api } from "./client.js";

/** Public-safe official Template catalog (no private component data). */
export function listAgentTemplates(): Promise<AgentTemplatePublicList> {
  return api.get<AgentTemplatePublicList>("/agent-templates");
}

/** Full replace-set write of an Agent's adopted Templates. */
export function updateAgentTemplates(agentId: string, body: UpdateAgentTemplates): Promise<AgentResourcesOutput> {
  return api.patch<AgentResourcesOutput>(`/agents/${encodeURIComponent(agentId)}/templates`, body);
}
