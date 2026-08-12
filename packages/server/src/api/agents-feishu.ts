import { createFeishuSetupChatSchema, MESSAGE_SOURCES, startFeishuRegistrationSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import * as chatService from "../services/chat/conversation.js";
import { notifyRecipients } from "../services/notifier.js";

const INSTALL_PROMPT = `请检查当前机器是否已安装 First Tree 支持的飞书 CLI（lark-cli）。这个命令随最新版 First Tree CLI 提供，并复用官方 @larksuite/cli；如果缺失，请根据当前 OS 和现有 First Tree 安装方式升级或安装最新版 First Tree CLI。不要擅自使用 sudo，不要配置、输出或写入飞书 App Secret。安装后请运行 lark-cli --version 和 lark-cli doctor 验证，并把结果回复我。如果安装需要管理员权限，请先询问我。`;

/** Class C — `/api/v1/agents/:uuid/feishu-binding`. */
export async function agentFeishuBindingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/feishu-binding", async (request) => {
    await requireAgentAccess(request, app.db, "visible");
    return { binding: await app.feishuIntegration.getBinding(request.params.uuid) };
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
