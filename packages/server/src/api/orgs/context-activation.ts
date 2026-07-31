import { contextActivationRequestSchema, contextActivationResponseSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { stampContextActivation } from "../../observability/request-context.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { validateExternalContextActivation } from "../../services/context-activation.js";

export async function orgContextActivationRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { orgId: string } }>("/validate", { config: { otelRecordBody: false } }, async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const input = contextActivationRequestSchema.parse(request.body);
    const startedAt = performance.now();
    try {
      const response = await validateExternalContextActivation(app.db, scope, input);
      stampContextActivation(request, {
        outcome: response.outcome,
        reasonCode: "reasonCode" in response ? response.reasonCode : undefined,
        contractVersion: input.schemaVersion,
        latencyMs: performance.now() - startedAt,
      });
      return contextActivationResponseSchema.parse(response);
    } catch (error) {
      stampContextActivation(request, {
        outcome: "denied",
        reasonCode: error instanceof Error ? error.name : "unknown_error",
        contractVersion: input.schemaVersion,
        latencyMs: performance.now() - startedAt,
      });
      throw error;
    }
  });
}
