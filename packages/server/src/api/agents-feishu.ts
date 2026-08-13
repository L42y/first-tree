import { createFeishuSetupChatSchema, startFeishuRegistrationSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import { createOrReuseFeishuCliSetupChat } from "../services/integrations/feishu/setup-chat.js";
import { notifyRecipients } from "../services/notifier.js";

/** Class C — `/api/v1/agents/:uuid/feishu-binding`. */
export async function agentFeishuBindingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/feishu-binding", async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "visible");
    const binding = await app.feishuIntegration.getBinding(request.params.uuid);
    const canManage = scope.role === "admin" || agent.managerId === scope.memberId;
    return {
      binding: binding && !canManage ? { ...binding, registrationUrl: null } : binding,
    };
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/feishu-binding/registrations",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { agent } = await requireAgentAccess(request, app.db, "manage");
      const body = startFeishuRegistrationSchema.parse(request.body);
      const binding = await app.feishuIntegration.startRegistration({
        agentId: agent.uuid,
        organizationId: agent.organizationId,
        displayName: body.displayName,
      });
      return reply.status(201).send({ binding });
    },
  );

  app.delete<{ Params: { uuid: string } }>("/:uuid/feishu-binding", async (request, reply) => {
    await requireAgentAccess(request, app.db, "manage");
    await app.feishuIntegration.revoke(request.params.uuid);
    return reply.status(204).send();
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/feishu-binding/setup-chat",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
      const body = createFeishuSetupChatSchema.parse(request.body);
      const result = await createOrReuseFeishuCliSetupChat(app.db, {
        agent,
        humanAgentId: scope.humanAgentId,
        retry: body.retry,
      });
      // The seam names the message to signal separately from the Task's opening
      // message: on reuse those differ, because a retry adds a new message while
      // `message` stays the original. Signalling the opening message with the
      // retry's recipients would wake them for something already delivered.
      if (result.notificationMessageId && result.recipients.length > 0) {
        notifyRecipients(app.notifier, result.recipients, result.notificationMessageId);
      }
      return reply.status(201).send({ chatId: result.chat.id });
    },
  );
}
