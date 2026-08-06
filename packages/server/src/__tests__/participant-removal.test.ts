/**
 * Removal authorization + writer — the mirror of `participant-invite`.
 *
 * Before this, removal existed only as the agent-JWT route and its whole
 * authorization was "is the caller a speaker of this chat", so any speaker
 * could remove any other speaker — including the chat owner, and including
 * agents belonging to a different member. These cases pin the shared rules
 * that both entrypoints now route through.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { createMeChat, leaveMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { removeParticipantFromChat } from "../services/participant-removal.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("removeParticipantFromChat", () => {
  const getApp = useTestApp();

  async function ownedAgent(app: ReturnType<typeof getApp>, memberId: string, orgId: string, label: string) {
    return createAgent(app.db, {
      name: `rm-${label}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: `Removal ${label}`,
      managerId: memberId,
      organizationId: orgId,
    });
  }

  async function membershipOf(app: ReturnType<typeof getApp>, chatId: string, agentId: string) {
    const [row] = await app.db
      .select({ accessMode: chatMembership.accessMode, role: chatMembership.role })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
      .limit(1);
    return row ?? null;
  }

  it("lets the chat owner remove an ordinary participant", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAdmin(app);
    const helper = await ownedAgent(app, peer.memberId, peer.organizationId, "helper");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });
    expect((await membershipOf(app, chatId, helper.uuid))?.accessMode).toBe("speaker");

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: helper.uuid,
    });

    expect(await membershipOf(app, chatId, helper.uuid)).toBeNull();
  });

  it("refuses to remove the chat owner, so the owner record survives", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const otherAgent = await ownedAgent(app, other.memberId, other.organizationId, "other");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [otherAgent.uuid],
    });
    // The other member joins as a speaker so they are a legitimate caller.
    await app.db
      .insert(chatMembership)
      .values({
        chatId,
        agentId: other.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });

    expect((await membershipOf(app, chatId, owner.humanAgentUuid))?.role).toBe("owner");

    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: other.humanAgentUuid,
        targetAgentId: owner.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // `chats` has no creator column — this row is the only record that the
    // chat has an owner, so losing it would be irrecoverable.
    expect(await membershipOf(app, chatId, owner.humanAgentUuid)).toEqual({
      accessMode: "speaker",
      role: "owner",
    });
  });

  it("refuses a bystander speaker removing someone else's agent", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const bystander = await createTestAdmin(app);
    const victimOwner = await createTestAdmin(app);
    const victim = await ownedAgent(app, victimOwner.memberId, victimOwner.organizationId, "victim");
    const bystanderAgent = await ownedAgent(app, bystander.memberId, bystander.organizationId, "bystander");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [victim.uuid, bystanderAgent.uuid],
    });

    // The bystander's own agent is a speaker, which was the entire previous
    // authorization requirement.
    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: bystanderAgent.uuid,
        targetAgentId: victim.uuid,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect((await membershipOf(app, chatId, victim.uuid))?.accessMode).toBe("speaker");
  });

  it("lets a manager recall their own agent from someone else's chat", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const manager = await createTestAdmin(app);
    const mine = await ownedAgent(app, manager.memberId, manager.organizationId, "mine");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [mine.uuid],
    });
    // The manager is a watcher via supervision; promote to speaker so they
    // are a legitimate caller without being the chat owner.
    await app.db
      .insert(chatMembership)
      .values({
        chatId,
        agentId: manager.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: manager.humanAgentUuid,
      targetAgentId: mine.uuid,
    });

    expect(await membershipOf(app, chatId, mine.uuid)).toBeNull();
  });

  it("refuses self-removal and points at leave", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "self");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: owner.humanAgentUuid,
        targetAgentId: owner.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a caller who is not a speaker of the chat", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const outsider = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "outside");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: outsider.humanAgentUuid,
        targetAgentId: helper.uuid,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("404s when the target is not a speaker", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "present");
    const absent = await ownedAgent(app, owner.memberId, owner.organizationId, "absent");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: owner.humanAgentUuid,
        targetAgentId: absent.uuid,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("drops the removed agent's pending inbox rows for that chat only", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "inbox");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });
    // A second chat the agent stays in — its queue must be untouched.
    const otherChat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [helper.uuid],
    });

    for (const target of [chatId, otherChat.id]) {
      await sendMessage(
        app.db,
        target,
        owner.humanAgentUuid,
        { source: "api", format: "text", content: "ping" },
        { allowRecipientlessSend: true },
      );
    }

    const pendingIn = async (chat: string) => {
      const rows = await app.db
        .select({ id: inboxEntries.id })
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, helper.inboxId),
            eq(inboxEntries.chatId, chat),
            eq(inboxEntries.status, "pending"),
          ),
        );
      return rows.length;
    };

    expect(await pendingIn(chatId)).toBeGreaterThan(0);
    const otherBefore = await pendingIn(otherChat.id);
    expect(otherBefore).toBeGreaterThan(0);

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: helper.uuid,
    });

    // Without this the agent keeps being woken for a chat it can no longer
    // write to — it burns a turn and then takes a 403 on reply.
    expect(await pendingIn(chatId)).toBe(0);
    expect(await pendingIn(otherChat.id)).toBe(otherBefore);
  });

  it("keeps a removed human readable while they still manage a speaker", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const theirAgent = await ownedAgent(app, other.memberId, other.organizationId, "supervised");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [theirAgent.uuid],
    });
    await app.db
      .insert(chatMembership)
      .values({
        chatId,
        agentId: other.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: other.humanAgentUuid,
    });

    // Removal takes away speaking, not sight: their own agent is still in
    // the chat producing work that belongs to them, so `recomputeChatWatchers`
    // re-materialises the watcher row.
    expect((await membershipOf(app, chatId, other.humanAgentUuid))?.accessMode).toBe("watcher");
  });

  it("fully detaches a removed human who manages no remaining speaker", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const ownerAgent = await ownedAgent(app, owner.memberId, owner.organizationId, "ownerside");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [ownerAgent.uuid],
    });
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: other.humanAgentUuid,
      role: "member",
      accessMode: "speaker",
      mode: "mention_only",
      source: "manual",
    });

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: other.humanAgentUuid,
    });

    expect(await membershipOf(app, chatId, other.humanAgentUuid)).toBeNull();
  });

  it("leaves agents in the chat untouched apart from the removed one", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const keep = await ownedAgent(app, owner.memberId, owner.organizationId, "keep");
    const drop = await ownedAgent(app, owner.memberId, owner.organizationId, "drop");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [keep.uuid, drop.uuid],
    });

    const remaining = await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: drop.uuid,
    });

    const ids = remaining.map((r) => r.agentId).sort();
    expect(ids).toEqual([keep.uuid, owner.humanAgentUuid].sort());
  });

  it("still resolves the owning member when the chat owner is an agent", async () => {
    const app = getApp();
    // Agent-created chats are the common shape: the `owner` row belongs to a
    // non-human agent, and its manager must still count as owner-side.
    const boss = await createTestAdmin(app);
    const creator = await ownedAgent(app, boss.memberId, boss.organizationId, "creator");
    const guestOwner = await createTestAdmin(app);
    const guest = await ownedAgent(app, guestOwner.memberId, guestOwner.organizationId, "guest");

    const chat = await createChat(app.db, creator.uuid, {
      type: "group",
      participantIds: [guest.uuid],
    });
    await app.db
      .insert(chatMembership)
      .values({
        chatId: chat.id,
        agentId: boss.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });

    await removeParticipantFromChat(app.db, {
      chatId: chat.id,
      callerAgentId: boss.humanAgentUuid,
      targetAgentId: guest.uuid,
    });

    expect(await membershipOf(app, chat.id, guest.uuid)).toBeNull();
  });

  it("refuses to touch a landing campaign trial chat", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "trial");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });
    await app.db
      .update(chats)
      .set({
        metadata: {
          landingCampaignTrial: {
            campaign: "production-scan",
            agentId: helper.uuid,
            skillSetId: "production-scan",
            skillSetVersion: "test",
            repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
            state: "running",
            inputLocked: false,
          },
        },
      })
      .where(eq(chats.id, chatId));

    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: owner.humanAgentUuid,
        targetAgentId: helper.uuid,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("also clears delivered inbox rows, which rebind would otherwise revive", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "delivered");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });
    await sendMessage(
      app.db,
      chatId,
      owner.humanAgentUuid,
      { source: "api", format: "text", content: "ping" },
      { allowRecipientlessSend: true },
    );
    // Simulate a claim that already handed the row to the runtime.
    await app.db
      .update(inboxEntries)
      .set({ status: "delivered" })
      .where(and(eq(inboxEntries.inboxId, helper.inboxId), eq(inboxEntries.chatId, chatId)));

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: helper.uuid,
    });

    // `resetDeliveredForInboxes` flips delivered → pending on the next bind
    // without consulting membership, so a surviving delivered row would wake
    // an agent that is no longer in the chat.
    const rows = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, helper.inboxId), eq(inboxEntries.chatId, chatId)));
    expect(rows).toHaveLength(0);
  });

  it("refuses to strand an unanswered request when removal detaches the target entirely", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const ownerAgent = await ownedAgent(app, owner.memberId, owner.organizationId, "asker");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [ownerAgent.uuid],
    });
    // `other` speaks here but manages nothing in the chat, so removal would
    // delete their row outright.
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: other.humanAgentUuid,
      role: "member",
      accessMode: "speaker",
      mode: "mention_only",
      source: "manual",
    });
    await app.db.insert(messages).values({
      id: crypto.randomUUID(),
      chatId,
      senderId: ownerAgent.uuid,
      format: "request",
      content: "need a decision",
      metadata: { mentions: [other.humanAgentUuid] },
      source: "agent",
    });

    // Detaching them would drop the request out of their Need-You queue,
    // deny them the chat, and leave open_request_count blocking archive.
    await expect(
      removeParticipantFromChat(app.db, {
        chatId,
        callerAgentId: owner.humanAgentUuid,
        targetAgentId: other.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await membershipOf(app, chatId, other.humanAgentUuid))?.accessMode).toBe("speaker");
  });

  it("allows removal with an open request when the target keeps a watcher row", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const theirAgent = await ownedAgent(app, other.memberId, other.organizationId, "theirs");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [theirAgent.uuid],
    });
    await app.db
      .insert(chatMembership)
      .values({
        chatId,
        agentId: other.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });
    await app.db.insert(messages).values({
      id: crypto.randomUUID(),
      chatId,
      senderId: theirAgent.uuid,
      format: "request",
      content: "need a decision",
      metadata: { mentions: [other.humanAgentUuid] },
      source: "agent",
    });

    // Their own agent stays, so the watcher row survives — they can still
    // see the request and join to answer it. No reason to block.
    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: other.humanAgentUuid,
    });

    expect((await membershipOf(app, chatId, other.humanAgentUuid))?.accessMode).toBe("watcher");
  });

  it("still resolves owner-side when the chat owner is a watcher, not a speaker", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const ownerAgent = await ownedAgent(app, owner.memberId, owner.organizationId, "ownerbot");
    const guestOwner = await createTestAdmin(app);
    const guest = await ownedAgent(app, guestOwner.memberId, guestOwner.organizationId, "guestbot");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [ownerAgent.uuid, guest.uuid],
    });

    // `workspace-leave` downgrades a departing owner to watcher and keeps
    // `role='owner'`, so the owner row is not necessarily a speaker. The
    // authority snapshot has to lock that agent row anyway — it is still the
    // row the owner-side decision is read from.
    await leaveMeChat(app.db, chatId, owner.humanAgentUuid);
    expect(await membershipOf(app, chatId, owner.humanAgentUuid)).toEqual({
      accessMode: "watcher",
      role: "owner",
    });

    // The owner's own agent is still a speaker and shares their owning
    // member, so it counts as owner-side and may remove the guest.
    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: ownerAgent.uuid,
      targetAgentId: guest.uuid,
    });

    expect(await membershipOf(app, chatId, guest.uuid)).toBeNull();
  });

  it("does not resurrect the removed agent through the watcher recompute", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "norevive");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    await removeParticipantFromChat(app.db, {
      chatId,
      callerAgentId: owner.humanAgentUuid,
      targetAgentId: helper.uuid,
    });

    const [row] = await app.db
      .select({ agentId: agents.uuid })
      .from(chatMembership)
      .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, helper.uuid)));
    expect(row).toBeUndefined();
  });
});
