import {
  orgGithubFeaturesOutputSchema,
  teamAgentAssignmentInputSchema,
  teamAgentCandidatesOutputSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { listTeamAgentCandidates, putTeamAgentAssignment } from "../../services/team-agent-settings.js";

/** Class B — `/api/v1/orgs/:orgId/team-agent`. */
export async function orgTeamAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/candidates", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    return teamAgentCandidatesOutputSchema.parse(
      await listTeamAgentCandidates(app.db, {
        organizationId: scope.organizationId,
        appSlug: app.config.oauth?.githubApp?.slug,
        now: new Date(),
        staleSeconds: app.config.runtime.presenceCleanupSeconds,
      }),
    );
  });

  app.put<{ Params: { orgId: string }; Body: unknown }>("/assignment", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const input = teamAgentAssignmentInputSchema.parse(request.body);
    return orgGithubFeaturesOutputSchema.parse(
      await putTeamAgentAssignment(app.db, scope.organizationId, input.agentUuid, {
        updatedBy: scope.userId,
        appSlug: app.config.oauth?.githubApp?.slug,
      }),
    );
  });
}
