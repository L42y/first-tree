import {
  type OrgGithubFeaturesOutput,
  orgGithubFeaturesOutputSchema,
  type TeamAgentCandidatesOutput,
  teamAgentCandidatesOutputSchema,
} from "@first-tree/shared";
import { api } from "./client.js";

function path(organizationId: string, operation: string): string {
  return `/orgs/${encodeURIComponent(organizationId)}/team-agent/${operation}`;
}

export async function getTeamAgentCandidates(organizationId: string): Promise<TeamAgentCandidatesOutput> {
  return teamAgentCandidatesOutputSchema.parse(await api.get<unknown>(path(organizationId, "candidates")));
}

export async function putTeamAgentAssignment(
  organizationId: string,
  agentUuid: string | null,
): Promise<OrgGithubFeaturesOutput> {
  return orgGithubFeaturesOutputSchema.parse(await api.put<unknown>(path(organizationId, "assignment"), { agentUuid }));
}
