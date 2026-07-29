import { updateAgentTemplatesSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import { assertNoRuntimeSwitchInProgress } from "../services/agent-runtime-switch.js";
import { assertMutableAgentIsNotLandingCampaignTrial } from "../services/landing-campaigns/guards.js";

/** Class C configuration routes for an Agent's ordered Template selection. */
export async function agentTemplatesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/templates", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    return app.agentTemplatesService.getAgentTemplates(request.params.uuid);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/templates", { config: { otelRecordBody: true } }, async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    assertNoRuntimeSwitchInProgress(agent);
    const body = updateAgentTemplatesSchema.parse(request.body);
    return app.agentTemplatesService.replaceAgentTemplates(request.params.uuid, body, scope.memberId);
  });
}
