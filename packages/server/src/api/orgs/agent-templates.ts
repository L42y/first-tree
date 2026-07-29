import { createAgentTemplateSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";

/**
 * Class B collection routes. Every active Team member can browse the official
 * catalog through their current Team; only an admin of the configured
 * publisher Team can create a Template.
 */
export async function orgAgentTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    await requireOrgMembership(request, app.db);
    return app.agentTemplatesService.listCatalog();
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    if (scope.role !== "admin") throw new ForbiddenError("Admin role required");
    const body = createAgentTemplateSchema.parse(request.body);
    const template = await app.agentTemplatesService.createTemplate(scope.organizationId, body, scope.memberId);
    return reply.status(201).send(template);
  });
}
