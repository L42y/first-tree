import type { ProvisionFirstTeamAgent, ProvisionFirstTeamAgentResult } from "@first-tree/shared";
import { api } from "./client.js";

/**
 * Provision the caller's first Team Agent.
 *
 * User-scoped on purpose — it is the one create call that must work with no
 * organization selected, because the Team is created by it. `withOrg` would
 * throw here. Creating further Agents inside a Team the user already works in
 * stays org-scoped (`createAgent`).
 */
export function provisionFirstTeamAgent(data: ProvisionFirstTeamAgent): Promise<ProvisionFirstTeamAgentResult> {
  return api.post<ProvisionFirstTeamAgentResult>("/me/team-agents", data);
}
