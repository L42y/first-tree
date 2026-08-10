import { AGENT_TYPES, updateAgentResourcesSchema, updateAgentTemplatesSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../errors.js";
import { requireAgentAccess } from "../scope/require-resource.js";
import { assertNoRuntimeSwitchInProgress } from "../services/agents/runtime/switch.js";
import { adoptAgentTemplates } from "../services/agents/templates/adoption.js";
import { assertMutableAgentIsNotLandingCampaignTrial } from "../services/landing-campaigns/guards.js";

export async function agentResourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/resources", async (request) => {
    await requireAgentAccess(request, app.db, "visible");
    return app.resourcesService.getAgentResources(request.params.uuid);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/resources", { config: { otelRecordBody: true } }, async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    assertNoRuntimeSwitchInProgress(agent);
    const body = updateAgentResourcesSchema.parse(request.body);
    return app.resourcesService.replaceAgentResources(request.params.uuid, body, scope.memberId);
  });

  /**
   * Full replace-set write of the Agent's adopted official Templates. The
   * read side lives in `GET /:uuid/resources` (`templateIds` + `version`).
   * Active-status is enforced inside the locked adoption transaction — not
   * as a route fast path — so suspended Agents always hit the service guard.
   */
  app.patch<{ Params: { uuid: string } }>("/:uuid/templates", async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    assertNoRuntimeSwitchInProgress(agent);
    if (agent.type === AGENT_TYPES.HUMAN) {
      throw new BadRequestError("Human Agents cannot adopt Agent Templates");
    }
    const body = updateAgentTemplatesSchema.parse(request.body);
    await adoptAgentTemplates(
      app.db,
      app.attachmentBlobStore,
      app.config.agentTemplates?.publisherOrgId,
      app.notifier,
      agent,
      scope.memberId,
      scope.humanAgentId,
      body,
    );
    return app.resourcesService.getAgentResources(request.params.uuid);
  });
}
