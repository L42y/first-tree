import type { FastifyInstance } from "fastify";
import { getPublicAgentTemplate, listPublicAgentTemplates } from "../services/agent-templates.js";

/**
 * Public official Agent Template catalog (safe read model only). Mounted
 * outside the user-auth scope in app.ts: anonymous visitors may browse the
 * active catalog and read safe Template details. The response shape is an
 * explicit projection — components, raw instructions, attachment ids, Skill
 * bodies, and MCP connection details never leave the server through here.
 */
export async function publicAgentTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listPublicAgentTemplates(app.db, app.config.agentTemplates?.publisherOrgId));

  app.get<{ Params: { slug: string } }>("/:slug", async (request) =>
    getPublicAgentTemplate(app.db, request.params.slug, app.config.agentTemplates?.publisherOrgId),
  );
}
