import { AGENT_RUNTIME_SESSION_HEADER, githubTaskReplyRequestSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { validateAgentRuntimeSession } from "../../services/agent-runtime-session.js";
import * as chatService from "../../services/chat/conversation.js";
import {
  GithubTaskReplyPublisherError,
  submitGithubTaskReply,
} from "../../services/scm/github/task-reply-publisher.js";

export async function agentGithubTaskRunRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string; runId: string } }>(
    "/:chatId/github-task-runs/:runId/reply",
    async (request, reply) => {
      const identity = requireAgent(request);
      const runtimeToken = request.headers[AGENT_RUNTIME_SESSION_HEADER];
      if (
        !identity.clientId ||
        typeof runtimeToken !== "string" ||
        runtimeToken.length === 0 ||
        !(await validateAgentRuntimeSession(app.db, identity.uuid, identity.clientId, runtimeToken))
      ) {
        return reply.status(403).send({
          error: "A valid active agent runtime session is required for GitHub App task reply publication.",
          code: "GITHUB_TASK_REPLY_RUNTIME_SESSION_REQUIRED",
        });
      }

      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const parsed = githubTaskReplyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues.map((issue) => issue.message).join("; "),
          code: "GITHUB_TASK_REPLY_INVALID_REQUEST",
        });
      }

      try {
        return await submitGithubTaskReply({
          db: app.db,
          chatId: request.params.chatId,
          runId: request.params.runId,
          callerAgentUuid: identity.uuid,
          callerClientId: identity.clientId,
          callerRuntimeSessionToken: runtimeToken,
          request: parsed.data,
          appCredentials: app.config.oauth?.githubApp,
        });
      } catch (error) {
        if (error instanceof GithubTaskReplyPublisherError) {
          return reply.status(error.statusCode).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );
}
