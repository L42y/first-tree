import {
  AGENT_TEMPLATE_WRITE_BODY_LIMIT,
  createAgentTemplateSchema,
  publishAgentTemplateSchema,
  retireAgentTemplateSchema,
  updateAgentTemplateSchema,
} from "@first-tree/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUser } from "../../scope/require-user.js";
import {
  createAgentTemplate,
  getAgentTemplate,
  listAgentTemplates,
  publishAgentTemplate,
  requireAgentTemplatePublisher,
  retireAgentTemplate,
  updateAgentTemplate,
} from "../../services/agent-templates.js";

/**
 * Publisher-internal Agent Template catalog maintenance.
 *
 * `/internal` is only a route namespace, not an authorization boundary:
 * every handler requires a valid user JWT plus current active admin
 * membership in the deployment-configured publisher Team
 * (`FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID`), probed in real time on
 * each request. There is deliberately no DELETE — retirement is terminal.
 */
export async function internalAgentTemplateRoutes(app: FastifyInstance): Promise<void> {
  async function publisherScope(request: FastifyRequest) {
    const { userId } = requireUser(request);
    return requireAgentTemplatePublisher(app.db, app.config, userId);
  }

  app.get("/", async (request) => {
    await publisherScope(request);
    return listAgentTemplates(app.db);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    await publisherScope(request);
    return getAgentTemplate(app.db, request.params.id);
  });

  // Finite route body limit sized from the shared write contract — the
  // default ~1 MiB cap would reject schema-valid payloads (see
  // AGENT_TEMPLATE_WRITE_BODY_LIMIT). publish/retire stay small-bodied.
  app.post("/", { bodyLimit: AGENT_TEMPLATE_WRITE_BODY_LIMIT }, async (request, reply) => {
    const scope = await publisherScope(request);
    const body = createAgentTemplateSchema.parse(request.body);
    const detail = await createAgentTemplate(app.db, app.attachmentBlobStore, scope, body);
    return reply.status(201).send(detail);
  });

  app.patch<{ Params: { id: string } }>("/:id", { bodyLimit: AGENT_TEMPLATE_WRITE_BODY_LIMIT }, async (request) => {
    const scope = await publisherScope(request);
    const body = updateAgentTemplateSchema.parse(request.body);
    return updateAgentTemplate(app.db, app.attachmentBlobStore, scope, request.params.id, body);
  });

  app.post<{ Params: { id: string } }>("/:id/publish", async (request) => {
    const scope = await publisherScope(request);
    const body = publishAgentTemplateSchema.parse(request.body);
    return publishAgentTemplate(app.db, app.attachmentBlobStore, scope, request.params.id, body);
  });

  app.post<{ Params: { id: string } }>("/:id/retire", async (request) => {
    const scope = await publisherScope(request);
    const body = retireAgentTemplateSchema.parse(request.body);
    return retireAgentTemplate(app.db, scope, request.params.id, body);
  });
}
