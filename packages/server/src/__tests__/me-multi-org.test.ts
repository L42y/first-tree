import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { invitationRedemptions } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agents/identity.js";
import { signTokensForUser } from "../services/auth/tokens.js";
import { rotateInvitation } from "../services/team/invitation.js";
import { createMember, deleteMember } from "../services/team/member.js";
import { leaveOrganization, selfCreateOrganization } from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedClient, useTestApp } from "./helpers.js";

/**
 * Attach `userId` to a freshly-created org with the requested role, mirroring
 * the helper that lives in admin-agents.test.ts. Each call returns a brand-
 * new org, the inserted member id, and the human agent provisioned for the
 * user in that org (so `scope.humanAgentId` is satisfied for routes that
 * resolve membership via `requireOrgMembership`).
 */
async function attachOrg(
  app: FastifyInstance,
  userId: string,
  role: "admin" | "member",
): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
  const orgId = `org-mm-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  let humanAgentId = "";
  await app.db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: orgId, name: `mm-${crypto.randomUUID().slice(0, 6)}`, displayName: "Multi-Org Side" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `mm-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Multi-Org Human",
      managerId: memberId,
      organizationId: orgId,
    });
    humanAgentId = human.uuid;
    await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
  });
  return { orgId, memberId, humanAgentId };
}

async function expectAdditionalTeamCreationRejectedAfterMembershipLoss(
  app: FastifyInstance,
  subject: { userId: string; username: string },
  deactivate: () => Promise<unknown>,
  teamDisplayName: string,
) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
  const blockerDb = connectDatabase(databaseUrl);
  let releaseUserLock: () => void = () => undefined;
  let announceUserLock: () => void = () => undefined;
  const userLockReleased = new Promise<void>((resolve) => {
    releaseUserLock = resolve;
  });
  const userLockHeld = new Promise<void>((resolve) => {
    announceUserLock = resolve;
  });
  const holder = blockerDb.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, subject.userId)).for("no key update").limit(1);
    announceUserLock();
    await userLockReleased;
  });

  try {
    await userLockHeld;
    let deactivationSettled = false;
    const deactivation = deactivate().finally(() => {
      deactivationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    // Leave/removal must wait on the same stable user lock used by
    // additional-Team authorization. Without it, the stale precheck can
    // commit a third first-Team boundary after this membership loss finishes.
    expect(deactivationSettled).toBe(false);

    const creation = selfCreateOrganization(app.db, {
      userId: subject.userId,
      username: subject.username,
      displayName: teamDisplayName,
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseUserLock();
    await holder;
    await deactivation;

    const outcome = await creation;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining("An active Team membership is required"),
      });
    }
    expect(
      await app.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.displayName, teamDisplayName)),
    ).toEqual([]);
  } finally {
    releaseUserLock();
    await holder.catch(() => undefined);
    await blockerDb.end();
  }
}

describe("Multi-org self-service", () => {
  const getApp = useTestApp();

  it("GET /me/organizations lists active memberships", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ id: string; role: string }>>();
    expect(list.length).toBe(1);
    expect(list[0]?.role).toBe("admin");
  });

  it("POST /me/organizations creates a new team", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Side Project" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ organization: { id: string; role: string } }>();
    expect(body.organization.role).toBe("admin");

    // Token unchanged — same userId. /me reflects the new membership.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ memberships: Array<{ organizationId: string }> }>();
    expect(meBody.memberships.some((m) => m.organizationId === body.organization.id)).toBe(true);
  });

  it("POST /me/organizations refuses a caller with no active Team membership", async () => {
    const app = getApp();
    const userId = uuidv7();
    await app.db.insert(users).values({
      id: userId,
      username: `no-membership-org-create-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "test",
      displayName: "No Membership Creator",
    });
    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { displayName: "Empty First Team" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("An active Team membership is required");
    const created = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.displayName, "Empty First Team"));
    expect(created).toHaveLength(0);

    await expect(
      selfCreateOrganization(app.db, {
        userId,
        username: `no-membership-org-create-${userId.slice(0, 8)}`,
        displayName: "Service Escape Team",
      }),
    ).rejects.toThrow("An active Team membership is required");
  });

  it("serializes additional-Team authority behind a concurrent last-membership leave", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-race-${crypto.randomUUID().slice(0, 8)}` });
    await expectAdditionalTeamCreationRejectedAfterMembershipLoss(
      app,
      {
        userId: admin.userId,
        username: admin.username,
      },
      () => leaveOrganization(app.db, admin.memberId),
      "Concurrent Leave Escape Team",
    );
  });

  it("serializes additional-Team authority behind a concurrent final-membership removal", async () => {
    const app = getApp();
    const host = await createTestAdmin(app, { username: `org-host-${crypto.randomUUID().slice(0, 8)}` });
    const username = `org-remove-${crypto.randomUUID().slice(0, 8)}`;
    const target = await createMember(app.db, host.organizationId, {
      username,
      displayName: "Removal Target",
      role: "member",
    });

    await expectAdditionalTeamCreationRejectedAfterMembershipLoss(
      app,
      { userId: target.userId, username },
      () => deleteMember(app.db, target.id, host.organizationId),
      "Concurrent Removal Escape Team",
    );
  });

  it("POST /me/organizations disambiguates display names that derive the same slug", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const create = (displayName: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/me/organizations",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { displayName },
      });

    // Display names carrying no ASCII alphanumerics all sanitize to the same
    // base slug. The slug is globally unique, so while the client chose it the
    // first such team anywhere rejected every later one with a 409 quoting an
    // identifier the user never typed.
    const first = await create("电商平台");
    expect(first.statusCode).toBe(201);
    const firstId = first.json<{ organization: { id: string } }>().organization.id;
    const [beforeRename] = await app.db.select().from(organizations).where(eq(organizations.id, firstId));

    // Renaming does not release the slug — it moves only the display name.
    // A `name` in the body is not an escape hatch either: the slug has no
    // update path, so it is stripped rather than applied.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${firstId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "电商平台-商城", name: "squatted-slug" },
    });
    expect(renamed.statusCode).toBe(200);
    const [afterRename] = await app.db.select().from(organizations).where(eq(organizations.id, firstId));
    expect(afterRename?.displayName).toBe("电商平台-商城");
    expect(afterRename?.name).toBe(beforeRename?.name);

    // Reusing the original display name still succeeds, on a fresh slug.
    const reused = await create("电商平台");
    expect(reused.statusCode).toBe(201);
    const reusedId = reused.json<{ organization: { id: string } }>().organization.id;

    const rows = await app.db
      .select()
      .from(organizations)
      .where(inArray(organizations.id, [firstId, reusedId]));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.name)).size).toBe(2);
    // Display names are deliberately not unique — two teams may share one.
    const alsoSameName = await create("电商平台-商城");
    expect(alsoSameName.statusCode).toBe(201);
  });

  it("POST /me/memberships/:memberId/leave soft-deletes membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // Create a second team so leaving the first leaves the user with one membership.
    await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Second" },
    });

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/v1/me/memberships/${admin.memberId}/leave`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(leaveRes.statusCode).toBe(204);

    // DB row is flipped to status='left'
    const rows = await app.db.select().from(members).where(eq(members.id, admin.memberId));
    expect(rows[0]?.status).toBe("left");

    // /me still works — token is keyed to userId, not memberId; the user
    // still has one active membership in the second team.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ memberships: Array<{ organizationId: string }> }>();
    expect(meBody.memberships.length).toBe(1);
    expect(meBody.memberships[0]?.organizationId).not.toBe(admin.organizationId);
  });

  it("POST /me/memberships/:memberId/leave hides memberships owned by another user", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const caller = await createTestAdmin(app);

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/v1/me/memberships/${owner.memberId}/leave`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(leaveRes.statusCode).toBe(404);
    expect(leaveRes.json<{ error: string }>().error).toContain(`Membership "${owner.memberId}" not found`);

    const rows = await app.db.select().from(members).where(eq(members.id, owner.memberId));
    expect(rows[0]?.status).toBe("active");
  });

  it("POST /me/organizations/join returns 404 for inactive or unknown invite tokens", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations/join",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { token: `missing-${crypto.randomUUID()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Invitation not found or no longer valid" });
  });

  it("POST /me/organizations/join creates membership and records redemption", async () => {
    const app = getApp();
    const inviter = await createTestAdmin(app);
    const invitee = await createTestAdmin(app);
    const sideOrg = await attachOrg(app, inviter.userId, "admin");
    const invitation = await rotateInvitation(app.db, sideOrg.orgId, inviter.userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations/join",
      headers: {
        authorization: `Bearer ${invitee.accessToken}`,
        "user-agent": "me-multi-org-test",
      },
      payload: { token: invitation.token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ organizationId: string; memberId: string; role: string }>();
    expect(body).toMatchObject({ organizationId: sideOrg.orgId, role: "member" });

    const [joined] = await app.db.select().from(members).where(eq(members.id, body.memberId)).limit(1);
    expect(joined).toMatchObject({
      userId: invitee.userId,
      organizationId: sideOrg.orgId,
      role: "member",
      status: "active",
    });

    const redemptions = await app.db
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.invitationId, invitation.id));
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]).toMatchObject({ userId: invitee.userId, userAgent: "me-multi-org-test" });
  });
});

describe("Connect code bootstrap", () => {
  const getApp = useTestApp();

  it("POST /me/connect-tokens returns a short connect code", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/connect-tokens",
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        host: "127.0.0.1:8000",
        "x-forwarded-proto": "http",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      token: string;
      command: string;
      bootstrapCommand: string;
      installerUrl: string | null;
      binName: string;
    }>();

    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.token).not.toContain("/");

    // Default test config runs channel=dev (server default), so the source-only
    // bootstrap collapses to the login line. binName follows the channel.
    expect(body.binName).toBe("first-tree-dev");
    expect(body.command).toBe(`first-tree-dev login ${body.token}`);
    expect(body.installerUrl).toBeNull();
    expect(body.bootstrapCommand).toBe(body.command);
    expect(body).not.toHaveProperty("npmSpec");
    expect(body).not.toHaveProperty("installMethod");
  });
});

describe("/me onboarding step inference", () => {
  const getApp = useTestApp();

  it("returns step=connect when no client/agent exists", async () => {
    const app = getApp();
    // Use a fresh OAuth user so we start clean — createTestAdmin pre-seeds
    // a client+agent which would push onboarding past the first step.
    const oauth = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=2001&login=fresh",
    });
    const fragment = oauth.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.json<{ onboarding: { step: string } }>().onboarding.step).toBe("connect");
  });

  it("GET /me/onboarding-step returns create_agent once a client exists without an autonomous agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedClient(app, admin.userId, admin.organizationId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/onboarding-step",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ step: "create_agent" });
  });

  /**
   * Regression for #239: the onboarding inference used to key off the JWT's
   * default `memberId`, so a user whose only autonomous agent lived in a
   * non-default org would still see `step=create_agent` even though the
   * onboarding was actually complete. Post JWT-scope-strip, both `clients`
   * and `agents` lookups are user-scoped (clients.user_id, members.user_id)
   * — the regression is structurally impossible because `request.user` no
   * longer carries `memberId`. This test pins that contract at the HTTP
   * boundary so a future "optimization" that re-introduces a member-keyed
   * shortcut fails CI.
   */
  it("returns step=completed when the only autonomous agent lives in a non-default org (regression #239)", async () => {
    const app = getApp();
    // createTestAdmin gives Alice a default org with only her human-self
    // agent + admin membership — onboarding should currently report `connect`
    // (no client) for that user.
    const alice = await createTestAdmin(app);

    // Spin up a side org Alice belongs to as a member, hang a client +
    // autonomous agent off her membership in that org. Crucially the agent
    // is NOT in the default org returned by createTestAdmin.
    const orgB = await attachOrg(app, alice.userId, "member");
    const clientId = await seedClient(app, alice.userId, orgB.orgId);
    await createAgent(app.db, {
      name: `regression-239-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Regression #239",
      managerId: orgB.memberId,
      organizationId: orgB.orgId,
      clientId,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ onboarding: { step: string } }>().onboarding.step).toBe("completed");
  });
});

describe("GET /me/pinned-agents", () => {
  const getApp = useTestApp();

  it("returns agents pinned to clients owned by the caller across memberships", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const clientId = await seedClient(app, admin.userId, admin.organizationId);
    const agent = await createAgent(app.db, {
      name: `pin-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Pinned Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/pinned-agents",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual(
      expect.objectContaining({
        agentId: agent.uuid,
        clientId,
        runtimeProvider: agent.runtimeProvider,
        status: "active",
      }),
    );
  });
});
