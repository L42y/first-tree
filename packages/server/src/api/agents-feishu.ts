import { createFeishuSetupChatSchema, MESSAGE_SOURCES, startFeishuRegistrationSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import * as chatService from "../services/chat/conversation.js";
import { notifyRecipients } from "../services/notifier.js";

const INSTALL_PROMPT = `请检查当前机器是否已安装飞书官方 lark-cli。如果没有，请根据当前 OS 和环境使用官方方式安装；不要擅自使用 sudo，遇到管理员权限时先询问我。安装后运行 lark-cli --version 和 lark-cli doctor 验证并回复结果。不要手工配置或输出 App Secret：需要调用 Bot 时，先用 First Tree 的 feishu credential-env 命令生成临时环境文件，source 后直接调用官方 lark-cli，并在完成后删除该临时文件。`;

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
      createFeishuSetupChatSchema.parse(request.body);
      const result = await chatService.createChat(app.db, {
        mode: "task",
        initiatorAgentId: scope.humanAgentId,
        organizationId: agent.organizationId,
        initialRecipientAgentIds: [agent.uuid],
        contextParticipantAgentIds: [],
        topic: `配置 ${agent.displayName} 的飞书 CLI`,
        initialMessage: {
          format: "markdown",
          content: INSTALL_PROMPT,
          metadata: { mentions: [agent.uuid] },
          source: MESSAGE_SOURCES.WEB,
        },
        source: "manual",
      });
      notifyRecipients(app.notifier, result.recipients, result.message.id);
      return reply.status(201).send({ chatId: result.chat.id });
    },
  );
}
