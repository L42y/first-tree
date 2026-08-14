import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { members } from "../../../db/schema/members.js";
import { ConflictError, NotFoundError } from "../../../errors.js";
import { type OnboardingCompletionStamp, stampOnboardingCompleted } from "../../onboarding-completion.js";
import { isFeishuBotReachable } from "./binding-state.js";
import { readFeishuCliCapability } from "./cli-capability.js";

const COMPLETION_ERROR_CODES = {
  botUnreachable: "feishu-bot-unreachable",
  clientUnavailable: "feishu-client-unavailable",
  cliNotReady: "feishu-cli-not-ready",
} as const;

export type CompleteFeishuOnboardingInput = {
  userId: string;
  organizationId: string;
  agentUuid: string;
};

type CompleteFeishuOnboardingOptions = {
  afterClientReadForTest?: () => Promise<void>;
};

/**
 * Validate the exact OpenTag handoff facts and stamp membership completion at
 * one database linearization point. Membership, Agent and Bot binding remain
 * locked through the stamp. The current Client is an ordinary snapshot read:
 * locking it here would invert retireClient's Client -> Agent lock order.
 */
export async function completeFeishuOnboarding(
  db: Database,
  input: CompleteFeishuOnboardingInput,
  options: CompleteFeishuOnboardingOptions = {},
): Promise<OnboardingCompletionStamp> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ id: members.id, onboardingCompletedAt: members.onboardingCompletedAt })
      .from(members)
      .where(
        and(
          eq(members.userId, input.userId),
          eq(members.organizationId, input.organizationId),
          eq(members.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!membership) throw new NotFoundError("Agent not found");

    const [agent] = await tx
      .select({ managerId: agents.managerId, clientId: agents.clientId })
      .from(agents)
      .where(
        and(
          eq(agents.uuid, input.agentUuid),
          eq(agents.organizationId, input.organizationId),
          eq(agents.status, "active"),
          eq(agents.type, "agent"),
        ),
      )
      .for("update")
      .limit(1);
    if (!agent || agent.managerId !== membership.id) throw new NotFoundError("Agent not found");

    // Completion is a durable membership fact. An authorized retry returns the
    // original stamp even if the operational handoff later becomes unhealthy.
    if (membership.onboardingCompletedAt) {
      return { completedAt: membership.onboardingCompletedAt, newlyCompleted: false };
    }

    const [binding] = await tx
      .select()
      .from(imBotBindings)
      .where(and(eq(imBotBindings.agentId, input.agentUuid), ne(imBotBindings.status, "revoked")))
      .for("update")
      .limit(1);
    if (!binding || !isFeishuBotReachable(binding, new Date())) {
      throw new ConflictError("The Agent's Feishu Bot is not reachable", {
        code: COMPLETION_ERROR_CODES.botUnreachable,
      });
    }

    if (!agent.clientId) {
      throw new ConflictError("The Agent does not have a current Computer", {
        code: COMPLETION_ERROR_CODES.clientUnavailable,
      });
    }
    const [client] = await tx
      .select({ metadata: clients.metadata, retiredAt: clients.retiredAt })
      .from(clients)
      .where(eq(clients.id, agent.clientId))
      .limit(1);
    if (!client || client.retiredAt) {
      throw new ConflictError("The Agent's current Computer is unavailable", {
        code: COMPLETION_ERROR_CODES.clientUnavailable,
      });
    }
    if (readFeishuCliCapability(client.metadata)?.available !== true) {
      throw new ConflictError("The Agent's current Computer has not reported lark-cli ready", {
        code: COMPLETION_ERROR_CODES.cliNotReady,
      });
    }

    await options.afterClientReadForTest?.();

    // Re-read the clock immediately before the durable stamp so time spent on
    // readiness reads cannot let an expired Bot lease pass on an older clock.
    const completionTime = new Date();
    if (!isFeishuBotReachable(binding, completionTime)) {
      throw new ConflictError("The Agent's Feishu Bot is not reachable", {
        code: COMPLETION_ERROR_CODES.botUnreachable,
      });
    }

    const stamped = await stampOnboardingCompleted(tx, membership.id, completionTime, {
      // Capability writers do not take the Agent lock. Re-evaluate readiness
      // inside the membership UPDATE statement so its MVCC snapshot is the
      // completion linearization point, without adding a Client row lock.
      condition: exists(
        tx
          .select({ ready: sql`1` })
          .from(clients)
          .where(
            and(
              eq(clients.id, agent.clientId),
              isNull(clients.retiredAt),
              sql`${clients.metadata} -> 'capabilities' -> 'lark-cli' ->> 'available' = 'true'`,
            ),
          ),
      ),
    });
    if (!stamped) {
      throw new ConflictError("The Agent's current Computer has not reported lark-cli ready", {
        code: COMPLETION_ERROR_CODES.cliNotReady,
      });
    }
    return stamped;
  });
}
