import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { ConflictError } from "../errors.js";
import { resolveCanonicalTeamSkillInvocation } from "../services/agents/resources/catalog.js";
import { createChat } from "../services/chat/conversation.js";
import { sendMessage } from "../services/chat/message.js";
import { uuidv7 } from "../uuid.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `skillPrecondition` is a transient, request-level guard for Team Skill
 * slash commands picked from the web composer menu; the
 * `metadata.teamSkillInvocation` marker it earns is the SERVER-OWNED,
 * persisted proof of Team intent. The message transaction:
 *
 *   1. locks the recipient's `agent_configs` row FOR UPDATE, so a
 *      concurrent config update either commits first (version mismatch →
 *      conflict) or blocks until after this commit (delivery then stamps
 *      the newer version and the Client settles a terminal notice) — there
 *      is no interleave that commits a v1-validated command as a
 *      marker-less v2 message;
 *   2. validates the recipient set and the locked config version;
 *   3. resolves the CANONICAL invocation identity through the trusted
 *      resources seam (effective row's own resourceId +
 *      `normalizeTeamSkillTargetSlug(payload.name)`), never from the
 *      request's untrusted fields;
 *   4. stamps the versioned marker only after all of the above.
 *
 * The precondition itself is never persisted; an inbound forged marker is
 * always stripped or overwritten.
 */
describe("sendMessage skillPrecondition → server-owned teamSkillInvocation marker", () => {
  const getApp = useTestApp();

  const RES_NAME = "Code Review"; // canonical slug: code-review
  const SLUG = "code-review";

  async function setup(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `sp-s-${uid}` });
    const { agent: peerA } = await createTestAgent(app, { name: `sp-a-${uid}` });
    const { agent: peerB } = await createTestAgent(app, { name: `sp-b-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peerA.uuid, peerB.uuid],
    });
    // Seed an enabled Team Skill for peerA: a team-scoped resource plus an
    // include binding, mirroring how replaceAgentResources projects one.
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: RES_NAME,
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: RES_NAME, description: "Review a change end to end.", body: "SKILL BODY", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peerA.uuid,
      type: "skill",
      mode: "include",
      resourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peerA.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");
    const validate = (precondition: { recipientAgentId: string; resourceId: string; requestedSlug: string }) =>
      resolveCanonicalTeamSkillInvocation(app.resourcesService, precondition);
    return { app, sender, peerA, peerB, chat, resourceId, configVersion: configRow.version, validate };
  }

  async function messageCount(app: ReturnType<ReturnType<typeof useTestApp>>, chatId: string) {
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    return rows.length;
  }

  function validPrecondition(ctx: { peerA: { uuid: string }; resourceId: string; configVersion: number }) {
    return {
      recipientAgentId: ctx.peerA.uuid,
      expectedConfigVersion: ctx.configVersion,
      resourceId: ctx.resourceId,
      requestedSlug: SLUG,
    };
  }

  it("stamps the canonical versioned marker from the validated effective row", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        skillPrecondition: validPrecondition(ctx),
      },
      { validateTeamSkillInvocation: validate },
    );
    expect(result.message.id).toBeTruthy();
    expect(await messageCount(app, chat.id)).toBe(1);
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    // The transient precondition itself is never persisted…
    expect(stored?.metadata ?? {}).not.toHaveProperty("skillPrecondition");
    // …and the marker is EXACTLY the canonical identity from the effective
    // row — the same values a Client will require at resolve time.
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
  });

  it("rejects a request slug that does not match the canonical effective-row slug", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/review src/",
          metadata: { mentions: [peerA.uuid] },
          skillPrecondition: { ...validPrecondition(ctx), requestedSlug: "review" },
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects a resourceId that is not an enabled Team Skill of the recipient", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          skillPrecondition: { ...validPrecondition(ctx), resourceId: crypto.randomUUID() },
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects when the config version moved after selection, inserting nothing", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, configVersion, validate } = ctx;
    // Admin removed/renamed the Team Skill after the menu was opened: bump
    // the config version, as a real resources update would.
    await app.db
      .update(agentConfigs)
      .set({ version: configVersion + 1 })
      .where(eq(agentConfigs.agentId, peerA.uuid));
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          skillPrecondition: validPrecondition(ctx),
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects when the routed recipients are not exactly the precondition agent", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, peerB, chat, validate } = ctx;
    for (const mentions of [[peerA.uuid, peerB.uuid], [peerB.uuid]]) {
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          {
            source: "web",
            format: "text",
            content: "/code-review src/",
            metadata: { mentions },
            skillPrecondition: validPrecondition(ctx),
          },
          { validateTeamSkillInvocation: validate },
        ),
      ).rejects.toThrow(ConflictError);
    }
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects a precondition on a send path without the trusted validation seam", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        skillPrecondition: validPrecondition(ctx),
      }),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("never stamps a marker for a normalized-collision skill group", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    // A second Team Skill whose name normalizes to the same target makes
    // the whole group duplicate_skill_target_name unavailable.
    const collisionId = uuidv7();
    await app.db.insert(resources).values({
      id: collisionId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "code_review",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "code_review", description: "d", body: "B", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peerA.uuid,
      type: "skill",
      mode: "include",
      resourceId: collisionId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 1,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          skillPrecondition: validPrecondition(ctx),
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("serializes a concurrent config update against the row lock: marker keeps the validated version", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    // Once the message transaction holds the agent_configs row lock, a
    // concurrent config update must BLOCK until after the commit — the
    // validator hook runs under the lock, so firing the update here proves
    // the ordering deterministically.
    let concurrentUpdate: Promise<unknown> | null = null;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        skillPrecondition: validPrecondition(ctx),
      },
      {
        validateTeamSkillInvocation: async (precondition) => {
          // Fire-and-forget on a separate connection: this UPDATE can only
          // complete after the message transaction commits.
          concurrentUpdate = app.db
            .update(agentConfigs)
            .set({ version: configVersion + 1 })
            .where(eq(agentConfigs.agentId, peerA.uuid));
          return validate(precondition);
        },
      },
    );
    expect(result.message.id).toBeTruthy();
    await concurrentUpdate;
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    // The message was validated and stamped at v1…
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
    // …and the config has since moved to v2, so the delivery-time stamp
    // will diverge from the marker — the Client's terminal-notice path.
    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peerA.uuid));
    expect(after?.version).toBe(configVersion + 1);
  });

  it("strips a client-supplied invocation marker when no valid precondition accompanies it", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/code-review src/",
      metadata: {
        mentions: [peerA.uuid],
        teamSkillInvocation: {
          version: 1,
          recipientAgentId: peerA.uuid,
          resourceId: uuidv7(),
          requestedSlug: SLUG,
          configVersion: 1,
        },
      },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata ?? {}).not.toHaveProperty("teamSkillInvocation");
  });

  it("overwrites a forged marker with the canonical one when the precondition passes", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: {
          mentions: [peerA.uuid],
          teamSkillInvocation: {
            version: 1,
            recipientAgentId: peerA.uuid,
            resourceId: crypto.randomUUID(),
            requestedSlug: "forged",
            configVersion: 999,
          },
        },
        skillPrecondition: validPrecondition(ctx),
      },
      { validateTeamSkillInvocation: validate },
    );
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
  });

  it("leaves sends without a precondition untouched (hand-typed runtime/local commands)", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/local-thing",
      metadata: { mentions: [peerA.uuid] },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata ?? {}).not.toHaveProperty("teamSkillInvocation");
  });
});
