import type {
  AgentResourcesOutput,
  AgentTemplatePublicList,
  AgentTemplatePublicTemplate,
  AgentTemplateSlug,
  UpdateAgentTemplates,
} from "@first-tree/shared";
import { api } from "./client.js";

/** Public-safe official Template catalog (no private component data). */
export function listAgentTemplates(): Promise<AgentTemplatePublicList> {
  return api.get<AgentTemplatePublicList>("/agent-templates");
}

/**
 * Public-safe Template detail by slug. Available anonymously — the shared API
 * client simply sends no Authorization header when the visitor is logged out.
 * Never returns component payloads, only `AgentTemplatePublicTemplate`.
 */
export function getAgentTemplate(slug: AgentTemplateSlug): Promise<AgentTemplatePublicTemplate> {
  return api.get<AgentTemplatePublicTemplate>(`/agent-templates/${encodeURIComponent(slug)}`);
}

/** Full replace-set write of an Agent's adopted Templates. */
export function updateAgentTemplates(agentId: string, body: UpdateAgentTemplates): Promise<AgentResourcesOutput> {
  return api.patch<AgentResourcesOutput>(`/agents/${encodeURIComponent(agentId)}/templates`, body);
}
