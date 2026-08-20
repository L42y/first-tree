import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { messages } from "../db/schema/messages.js";
import { ConflictError } from "../errors.js";
import { createChat } from "../services/chat/conversation.js";
import { sendMessage } from "../services/chat/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `skillPrecondition` is a transient, request-level guard for Team Skill
 * slash commands picked from the web composer menu. The composer may have
 * chosen `/review` against config v1; if the admin removes or renames that
 * Skill (bumping the agent's config version) before the POST lands, the
 * command must NOT fall through to a same-named LOCAL Skill on the agent's
 * machine. The message transaction re-validates the recipient set and the
 * config version before inserting — the web's fresh pre-send GET and this
 * POST are not atomic, so the proof has to happen here.
 *
 * The field is never persisted into message metadata; these tests pin both
 * the conflict semantics and the happy path at the service layer.
 */
describe("sendMessage skillPrecondition", () => {
  const getApp = useTestApp();

  const RES_ID = crypto.randomUUID();
  const SLUG = "review";

  async function setup(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `sp-s-${uid}` });
    const { agent: peerA } = await createTestAgent(app, { name: `sp-a-${uid}` });
    const { agent: peerB } = await createTestAgent(app, { name: `sp-b-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peerA.uuid, peerB.uuid],
    });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peerA.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");
    return { app, sender, peerA, peerB, chat, configVersion: configRow.version };
  }

  async function messageCount(app: ReturnType<ReturnType<typeof useTestApp>>, chatId: string) {
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    return rows.length;
  }

  it("accepts when the recipient set and config version both match", async () => {
    const { app, sender, peerA, chat, configVersion } = await setup(crypto.randomUUID().slice(0, 6));
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/review src/",
      metadata: { mentions: [peerA.uuid] },
      skillPrecondition: {
        recipientAgentId: peerA.uuid,
        expectedConfigVersion: configVersion,
        resourceId: RES_ID,
        slug: SLUG,
      },
    });
    expect(result.message.id).toBeTruthy();
    expect(await messageCount(app, chat.id)).toBe(1);
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    // The transient precondition itself is never persisted…
    expect(stored?.metadata ?? {}).not.toHaveProperty("skillPrecondition");
    // …but the server-owned invocation marker is: this is what lets the
    // recipient's Client recognise the Team intent after a delayed delivery.
    expect(stored?.metadata).toMatchObject({
      teamSkillInvocation: { resourceId: RES_ID, slug: SLUG, configVersion },
    });
  });

  it("strips a client-supplied invocation marker when no valid precondition accompanies it", async () => {
    const { app, sender, peerA, chat } = await setup(crypto.randomUUID().slice(0, 6));
    // A forged marker without a precondition must not survive the write
    // path — otherwise any sender could make an arbitrary slash command
    // look like server-validated Team intent.
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/review src/",
      metadata: {
        mentions: [peerA.uuid],
        teamSkillInvocation: { resourceId: RES_ID, slug: SLUG, configVersion: 1 },
      },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata ?? {}).not.toHaveProperty("teamSkillInvocation");
  });

  it("overwrites a forged marker with the server-validated one when the precondition passes", async () => {
    const { app, sender, peerA, chat, configVersion } = await setup(crypto.randomUUID().slice(0, 6));
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/review src/",
      metadata: {
        mentions: [peerA.uuid],
        teamSkillInvocation: { resourceId: crypto.randomUUID(), slug: "forged", configVersion: 999 },
      },
      skillPrecondition: {
        recipientAgentId: peerA.uuid,
        expectedConfigVersion: configVersion,
        resourceId: RES_ID,
        slug: SLUG,
      },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata).toMatchObject({
      teamSkillInvocation: { resourceId: RES_ID, slug: SLUG, configVersion },
    });
  });

  it("rejects with a conflict and inserts nothing when the config version moved after selection", async () => {
    const { app, sender, peerA, chat, configVersion } = await setup(crypto.randomUUID().slice(0, 6));
    // Admin removed/renamed the Team Skill after the menu was opened: bump
    // the config version, as a real resources update would.
    await app.db
      .update(agentConfigs)
      .set({ version: configVersion + 1 })
      .where(eq(agentConfigs.agentId, peerA.uuid));
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "web",
        format: "text",
        content: "/review src/",
        metadata: { mentions: [peerA.uuid] },
        skillPrecondition: {
          recipientAgentId: peerA.uuid,
          expectedConfigVersion: configVersion,
          resourceId: RES_ID,
          slug: SLUG,
        },
      }),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects when the routed recipients are not exactly the precondition agent", async () => {
    const { app, sender, peerA, peerB, chat, configVersion } = await setup(crypto.randomUUID().slice(0, 6));
    // Two routed recipients: a Team Skill command is only provable for a
    // unique recipient.
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "web",
        format: "text",
        content: "/review src/",
        metadata: { mentions: [peerA.uuid, peerB.uuid] },
        skillPrecondition: {
          recipientAgentId: peerA.uuid,
          expectedConfigVersion: configVersion,
          resourceId: RES_ID,
          slug: SLUG,
        },
      }),
    ).rejects.toThrow(ConflictError);
    // A different single recipient than the one the command was chosen for.
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "web",
        format: "text",
        content: "/review src/",
        metadata: { mentions: [peerB.uuid] },
        skillPrecondition: {
          recipientAgentId: peerA.uuid,
          expectedConfigVersion: configVersion,
          resourceId: RES_ID,
          slug: SLUG,
        },
      }),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("leaves sends without a precondition untouched (hand-typed runtime/local commands)", async () => {
    const { app, sender, peerA, chat } = await setup(crypto.randomUUID().slice(0, 6));
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/local-thing",
      metadata: { mentions: [peerA.uuid] },
    });
    expect(result.message.id).toBeTruthy();
    expect(await messageCount(app, chat.id)).toBe(1);
  });
});
