import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { createChat } from "../services/chat/conversation.js";
import { getChatAgentStatuses } from "../services/chat/sessions/status.js";
import { createTestAgent, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

/**
 * Rollout gate for Team Skill slash commands
 * (`AgentChatStatus.teamSkillInvocationSupported`). The Web composer offers
 * Team Skills only when the recipient's bound, route-consistent connected
 * client runs a version that parses the server-owned `teamSkillInvocation`
 * message marker fail-closed. The gate is projected from existing rows —
 * agent binding + presence + `clients.sdk_version` — with no new persisted
 * state: unbound, offline, unknown-version, pre-epoch, and pre-0.5.22
 * clients all read as unsupported.
 */
describe("AgentChatStatus teamSkillInvocationSupported gate", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `gs-${crypto.randomUUID().slice(0, 6)}` });
    const { agent, clientId } = await createTestAgent(app, { name: `gp-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, sender.agent.uuid, { type: "group", participantIds: [agent.uuid] });
    return { app, agent, clientId, chat };
  }

  async function supportFor(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    chatId: string,
    agentId: string,
  ): Promise<boolean | undefined> {
    const statuses = await getChatAgentStatuses(app.db, chatId);
    return statuses.find((s) => s.agentId === agentId)?.teamSkillInvocationSupported;
  }

  async function connectWithVersion(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    agentUuid: string,
    clientId: string,
    sdkVersion: string | null,
  ) {
    await seedHealthyAgentRuntime(app, { agentUuid, clientId });
    await app.db.update(clients).set({ sdkVersion }).where(eq(clients.id, clientId));
  }

  it("is false while the agent has no live route-consistent client", async () => {
    const { app, agent, chat } = await setup();
    expect(await supportFor(app, chat.id, agent.uuid)).toBe(false);
  });

  it("is true for a connected client on the first marker-reader stable", async () => {
    const { app, agent, clientId, chat } = await setup();
    await connectWithVersion(app, agent.uuid, clientId, "0.5.22");
    expect(await supportFor(app, chat.id, agent.uuid)).toBe(true);
  });

  it("is false for older, unknown, and pre-epoch client versions", async () => {
    const { app, agent, clientId, chat } = await setup();
    for (const version of ["0.5.21", "0.5.0", "0.14.8", "garbage", "", null]) {
      await connectWithVersion(app, agent.uuid, clientId, version);
      expect(await supportFor(app, chat.id, agent.uuid), `version ${JSON.stringify(version)}`).toBe(false);
    }
  });

  it("maps the staging line one patch after the stable base, like the runtime-switch gate", async () => {
    const { app, agent, clientId, chat } = await setup();
    // A staging patch is the next patch after its stable base: 0.5.22-staging
    // predates the 0.5.22 stable reader, 0.5.23-staging contains it.
    await connectWithVersion(app, agent.uuid, clientId, "0.5.22-staging.1.1");
    expect(await supportFor(app, chat.id, agent.uuid)).toBe(false);
    await connectWithVersion(app, agent.uuid, clientId, "0.5.23-staging.1.1");
    expect(await supportFor(app, chat.id, agent.uuid)).toBe(true);
  });
});
