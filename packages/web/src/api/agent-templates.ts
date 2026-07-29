import type {
  AgentTemplateCatalogOutput,
  AgentTemplatesForAgentOutput,
  UpdateAgentTemplates,
} from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export function listAgentTemplates(): Promise<AgentTemplateCatalogOutput> {
  return api.get<AgentTemplateCatalogOutput>(withOrg("/agent-templates"));
}

export function getAgentTemplates(agentId: string): Promise<AgentTemplatesForAgentOutput> {
  return api.get<AgentTemplatesForAgentOutput>(`/agents/${encodeURIComponent(agentId)}/templates`);
}

export function replaceAgentTemplates(
  agentId: string,
  input: UpdateAgentTemplates,
): Promise<AgentTemplatesForAgentOutput> {
  return api.patch<AgentTemplatesForAgentOutput>(`/agents/${encodeURIComponent(agentId)}/templates`, input);
}
