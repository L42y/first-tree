import { retireAgentTemplateSchema, updateAgentTemplateSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentTemplateAccess } from "../scope/require-agent-template-access.js";

/** Class C routes for the publisher Team's full Template definitions. */
export async function agentTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { templateId: string } }>("/:templateId", async (request) => {
    await requireAgentTemplateAccess(request, app.db, "read");
    return app.agentTemplatesService.getDefinition(request.params.templateId);
  });

  app.patch<{ Params: { templateId: string } }>(
    "/:templateId",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { scope } = await requireAgentTemplateAccess(request, app.db, "write");
      const body = updateAgentTemplateSchema.parse(request.body);
      return app.agentTemplatesService.updateTemplate(request.params.templateId, body, scope.memberId);
    },
  );

  app.delete<{ Params: { templateId: string } }>(
    "/:templateId",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { scope } = await requireAgentTemplateAccess(request, app.db, "write");
      const body = retireAgentTemplateSchema.parse(request.body);
      return app.agentTemplatesService.retireTemplate(request.params.templateId, body.expectedVersion, scope.memberId);
    },
  );
}
