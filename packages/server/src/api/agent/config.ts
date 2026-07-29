import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { resolveCurrentRuntimeConfig } from "../../services/runtime-config-snapshot.js";

/**
 * Agent-facing runtime config endpoint (Step 4).
 *
 * The agent's own bearer token authenticates the request. Sensitive env
 * values are returned in plaintext — the runtime needs them to launch its
 * subprocess. The token holder already has full agent privileges, so
 * exposing values to the token bearer matches the security model.
 */
export async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/config", async (request) => {
    const identity = requireAgent(request);
    return resolveCurrentRuntimeConfig(
      () => app.configService.getDecrypted(identity.uuid),
      (config) => app.resourcesService.resolveRuntimeConfig(config),
    );
  });
}
