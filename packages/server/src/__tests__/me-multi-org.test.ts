import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, type Database, sslOptions } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { invitationRedemptions } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agents/identity.js";
import { signTokensForUser } from "../services/auth/tokens.js";
import { rotateInvitation } from "../services/team/invitation.js";
import { createMember, deleteMember } from "../services/team/member.js";
import {
  ensureMembership,
  leaveOrganization,
  MEMBERSHIP_RECOVERY_POLICIES,
  selfCreateOrganization,
} from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedClient, useTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForPostgresLockWait(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

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
  deactivate: (db: Database) => Promise<unknown>,
  teamDisplayName: string,
) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
  const blockerDb = connectDatabase(databaseUrl);
  const deactivationApplicationName = `loss_first_${crypto.randomUUID().slice(0, 8)}`;
  const creationApplicationName = `creation_second_${crypto.randomUUID().slice(0, 8)}`;
  const deactivationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, deactivationApplicationName));
  const creationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, creationApplicationName));
  const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
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
    const deactivation = deactivate(deactivationDb);
    await waitForPostgresLockWait(observer, deactivationApplicationName);

    const creation = selfCreateOrganization(creationDb, {
      userId: subject.userId,
      username: subject.username,
      displayName: teamDisplayName,
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitForPostgresLockWait(observer, creationApplicationName);
    releaseUserLock();
    await holder;
    await deactivation;

    const outcome = await creation;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining("Team creation authority changed"),
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
    await deactivationDb.end();
    await creationDb.end();
    await observer.end();
  }
}

async function expectAdditionalTeamCreationWinsBeforeMembershipLoss(
  app: FastifyInstance,
  subject: { userId: string; username: string },
  deactivate: (db: Database) => Promise<unknown>,
  teamDisplayName: string,
) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
  const blockerDb = connectDatabase(databaseUrl);
  const creationApplicationName = `creation_first_${crypto.randomUUID().slice(0, 8)}`;
  const deactivationApplicationName = `loss_second_${crypto.randomUUID().slice(0, 8)}`;
  const creationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, creationApplicationName));
  const deactivationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, deactivationApplicationName));
  const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
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
    const creation = selfCreateOrganization(creationDb, {
      userId: subject.userId,
      username: subject.username,
      displayName: teamDisplayName,
    });
    await waitForPostgresLockWait(observer, creationApplicationName);

    const deactivation = deactivate(deactivationDb);
    await waitForPostgresLockWait(observer, deactivationApplicationName);
    releaseUserLock();
    await holder;
    const [created] = await Promise.all([creation, deactivation]);

    const activeMemberships = await app.db
      .select({ organizationId: members.organizationId })
      .from(members)
      .where(and(eq(members.userId, subject.userId), eq(members.status, "active")));
    expect(activeMemberships).toEqual([{ organizationId: created.organizationId }]);
  } finally {
    releaseUserLock();
    await holder.catch(() => undefined);
    await blockerDb.end();
    await creationDb.end();
    await deactivationDb.end();
    await observer.end();
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
      (db) => leaveOrganization(db, admin.memberId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED),
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
      (db) => deleteMember(db, target.id, host.organizationId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED),
      "Concurrent Removal Escape Team",
    );
  });

  it("does not create an additional Team after account suspension wins the user fence", async () => {
    const app = getApp();
    const account = await createTestAdmin(app, { username: `org-suspend-${crypto.randomUUID().slice(0, 8)}` });
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const suspensionApplicationName = `create_suspend_${crypto.randomUUID().slice(0, 8)}`;
    const creationApplicationName = `create_after_suspend_${crypto.randomUUID().slice(0, 8)}`;
    const suspensionDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, suspensionApplicationName));
    const creationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, creationApplicationName));
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    let releaseBlocker = (): void => undefined;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    try {
      const holder = blocker.begin(async (tx) => {
        await tx.unsafe("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [account.userId]);
        blockerReady();
        await blockerRelease;
      });
      await ready;

      const suspension = Promise.resolve(
        suspensionDb.update(users).set({ status: "suspended" }).where(eq(users.id, account.userId)),
      );
      await waitForPostgresLockWait(observer, suspensionApplicationName);
      const teamDisplayName = `Suspended Create ${crypto.randomUUID().slice(0, 8)}`;
      const creation = selfCreateOrganization(creationDb, {
        userId: account.userId,
        username: account.username,
        displayName: teamDisplayName,
      });
      await waitForPostgresLockWait(observer, creationApplicationName);

      releaseBlocker();
      await holder;
      await suspension;
      await expect(creation).rejects.toThrow(/suspended/i);
      await expect(
        app.db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.displayName, teamDisplayName)),
      ).resolves.toEqual([]);
    } finally {
      releaseBlocker();
      await suspensionDb.end();
      await creationDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("does not join another Team after account suspension wins the user fence", async () => {
    const app = getApp();
    const account = await createTestAdmin(app, { username: `join-suspend-${crypto.randomUUID().slice(0, 8)}` });
    const destinationId = `org-join-suspend-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(organizations).values({
      id: destinationId,
      name: `join-suspend-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Suspended Join Destination",
    });
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const suspensionApplicationName = `join_suspend_${crypto.randomUUID().slice(0, 8)}`;
    const joinApplicationName = `join_after_suspend_${crypto.randomUUID().slice(0, 8)}`;
    const suspensionDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, suspensionApplicationName));
    const joinDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, joinApplicationName));
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    let releaseBlocker = (): void => undefined;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    try {
      const holder = blocker.begin(async (tx) => {
        await tx.unsafe("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [account.userId]);
        blockerReady();
        await blockerRelease;
      });
      await ready;

      const suspension = Promise.resolve(
        suspensionDb.update(users).set({ status: "suspended" }).where(eq(users.id, account.userId)),
      );
      await waitForPostgresLockWait(observer, suspensionApplicationName);
      const joining = ensureMembership(joinDb, {
        userId: account.userId,
        organizationId: destinationId,
        role: "member",
        displayName: "Stale Join Snapshot",
        username: account.username,
      });
      await waitForPostgresLockWait(observer, joinApplicationName);

      releaseBlocker();
      await holder;
      await suspension;
      await expect(joining).rejects.toThrow(/suspended/i);
      await expect(
        app.db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.userId, account.userId), eq(members.organizationId, destinationId))),
      ).resolves.toEqual([]);
    } finally {
      releaseBlocker();
      await suspensionDb.end();
      await joinDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("lets an additional-Team creation that holds the user fence commit before final leave", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-create-first-${crypto.randomUUID().slice(0, 8)}` });
    await expectAdditionalTeamCreationWinsBeforeMembershipLoss(
      app,
      { userId: admin.userId, username: admin.username },
      (db) => leaveOrganization(db, admin.memberId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED),
      "Creation Wins Before Leave",
    );
  });

  it("rejects a newly-started additional-Team request after final membership loss", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-after-repair-${crypto.randomUUID().slice(0, 8)}` });
    await leaveOrganization(app.db, admin.memberId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED);

    await expect(
      selfCreateOrganization(app.db, {
        userId: admin.userId,
        username: admin.username,
        displayName: "Fresh Request After Repair",
      }),
    ).rejects.toThrow("An active Team membership is required to create another Team");

    const activeMemberships = await app.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, admin.userId), eq(members.status, "active")));
    expect(activeMemberships).toHaveLength(0);
  });

  it("serializes simultaneous losses of a multi-Team user's final two memberships", async () => {
    const app = getApp();
    const account = await createTestAdmin(app, { username: `multi-final-${crypto.randomUUID().slice(0, 8)}` });
    const second = await selfCreateOrganization(app.db, {
      userId: account.userId,
      username: account.username,
      displayName: "Multi Final Side Team",
    });

    await Promise.all([
      leaveOrganization(app.db, account.memberId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED),
      leaveOrganization(app.db, second.memberId, MEMBERSHIP_RECOVERY_POLICIES.REPAIR_REQUIRED),
    ]);

    const membershipRows = await app.db
      .select({ id: members.id, status: members.status })
      .from(members)
      .where(eq(members.userId, account.userId));
    expect(membershipRows).toEqual(
      expect.arrayContaining([
        { id: account.memberId, status: "left" },
        { id: second.memberId, status: "left" },
      ]),
    );
    expect(membershipRows.filter((membership) => membership.status === "active")).toHaveLength(0);
  });

  it("keeps an admin-removed final membership at the repair boundary", async () => {
    const app = getApp();
    const host = await createTestAdmin(app, { username: `remove-host-${crypto.randomUUID().slice(0, 8)}` });
    const target = await createMember(app.db, host.organizationId, {
      username: `remove-final-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Removed Final Member",
      role: "member",
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${host.organizationId}/members/${target.id}`,
      headers: { authorization: `Bearer ${host.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);

    const membershipRows = await app.db
      .select({
        id: members.id,
        agentId: members.agentId,
        organizationId: members.organizationId,
        status: members.status,
      })
      .from(members)
      .where(eq(members.userId, target.userId));
    expect(membershipRows).toContainEqual({
      id: target.id,
      agentId: target.agentId,
      organizationId: host.organizationId,
      status: "removed",
    });
    expect(membershipRows.filter((membership) => membership.status === "active")).toHaveLength(0);
  });

  it("retries a concurrent final admin removal without creating a Team", async () => {
    const app = getApp();
    const host = await createTestAdmin(app, { username: `remove-retry-host-${crypto.randomUUID().slice(0, 8)}` });
    const target = await createMember(app.db, host.organizationId, {
      username: `remove-retry-target-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Removal Retry Target",
      role: "member",
    });
    const remove = () =>
      app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${host.organizationId}/members/${target.id}`,
        headers: { authorization: `Bearer ${host.accessToken}` },
      });

    const results = await Promise.all([remove(), remove()]);

    expect(results.map((result) => result.statusCode)).toEqual([204, 204]);
    const membershipRows = await app.db
      .select({ id: members.id, status: members.status })
      .from(members)
      .where(eq(members.userId, target.userId));
    expect(membershipRows.filter((membership) => membership.status === "active")).toHaveLength(0);
    expect(membershipRows.filter((membership) => membership.id === target.id)).toEqual([
      { id: target.id, status: "removed" },
    ]);
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

  it("keeps a final self-leave at the repair boundary across retries", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, {
      username: `final-leave-${crypto.randomUUID().slice(0, 8)}`,
    });
    const leave = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/me/memberships/${admin.memberId}/leave`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

    const retryResults = await Promise.all([leave(), leave()]);
    expect(retryResults.map((result) => result.statusCode)).toEqual([204, 204]);

    const membershipRows = await app.db
      .select({ id: members.id, organizationId: members.organizationId, status: members.status })
      .from(members)
      .where(eq(members.userId, admin.userId));
    expect(membershipRows).toContainEqual({
      id: admin.memberId,
      organizationId: admin.organizationId,
      status: "left",
    });
    expect(membershipRows.filter((membership) => membership.status === "active")).toHaveLength(0);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ code: "membership-repair-required" });
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

  it("keeps physical Team and account lifecycle routes unsupported and side-effect free", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, {
      username: `unsupported-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
    });
    const authorization = { authorization: `Bearer ${admin.accessToken}` };

    for (const request of [
      { method: "DELETE", url: `/api/v1/orgs/${admin.organizationId}` },
      { method: "POST", url: `/api/v1/orgs/${admin.organizationId}/reactivate` },
      { method: "DELETE", url: "/api/v1/me/account" },
      { method: "POST", url: "/api/v1/me/account/reactivate" },
    ] as const) {
      const response = await app.inject({ ...request, headers: authorization });
      expect(response.statusCode).toBe(404);
    }

    const [organization] = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, admin.organizationId));
    const [account] = await app.db.select({ status: users.status }).from(users).where(eq(users.id, admin.userId));
    const [membership] = await app.db
      .select({ status: members.status, agentId: members.agentId })
      .from(members)
      .where(eq(members.id, admin.memberId));
    const [mirror] = await app.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.uuid, admin.humanAgentUuid));

    expect(organization).toEqual({ id: admin.organizationId });
    expect(account).toEqual({ status: "active" });
    expect(membership).toEqual({ status: "active", agentId: admin.humanAgentUuid });
    expect(mirror).toEqual({ status: "active" });
  });
});

describe("Invitation-only final-membership boundary", () => {
  const getApp = useTestApp({ allowedOrganizationId: DEFAULT_ORG_ID });

  it("rejects a valid invitation for a Team outside the deployment gate without side effects", async () => {
    const app = getApp();
    const invitee = await createTestAdmin(app, { username: `invite-gate-${crypto.randomUUID().slice(0, 8)}` });
    const inviter = await createTestAdmin(app, { username: `invite-side-${crypto.randomUUID().slice(0, 8)}` });
    const sideOrg = await attachOrg(app, inviter.userId, "admin");
    const invitation = await rotateInvitation(app.db, sideOrg.orgId, inviter.userId);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations/join",
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token: invitation.token },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "invite-not-allowed" });
    expect(
      await app.db
        .select()
        .from(members)
        .where(and(eq(members.userId, invitee.userId), eq(members.organizationId, sideOrg.orgId))),
    ).toHaveLength(0);
    expect(
      await app.db
        .select()
        .from(invitationRedemptions)
        .where(
          and(eq(invitationRedemptions.userId, invitee.userId), eq(invitationRedemptions.invitationId, invitation.id)),
        ),
    ).toHaveLength(0);
  });

  it("does not create a personal Team and rejects workspace state after final self-leave", async () => {
    const app = getApp();
    const member = await createTestAdmin(app, { username: `invite-final-${crypto.randomUUID().slice(0, 8)}` });

    const leave = await app.inject({
      method: "POST",
      url: `/api/v1/me/memberships/${member.memberId}/leave`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(leave.statusCode).toBe(204);

    const activeMemberships = await app.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, member.userId), eq(members.status, "active")));
    expect(activeMemberships).toEqual([]);
    const personalTeams = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.displayName, "Test Admin's team"));
    expect(personalTeams).toEqual([]);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ code: "invite-required" });

    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: member.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toMatchObject({ code: "invite-required" });

    const oldTeam = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${member.organizationId}/members`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(oldTeam.statusCode).toBe(403);
  });

  it("keeps an admin-removed final member at the invitation boundary with a suspended historical mirror", async () => {
    const app = getApp();
    const host = await createTestAdmin(app, { username: `invite-host-${crypto.randomUUID().slice(0, 8)}` });
    const target = await createMember(app.db, host.organizationId, {
      username: `invite-removed-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Invite Removed Target",
      role: "member",
    });
    const targetTokens = await signTokensForUser(app.config.secrets.jwtSecret, target.userId, app.config.auth);

    const remove = () =>
      app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${host.organizationId}/members/${target.id}`,
        headers: { authorization: `Bearer ${host.accessToken}` },
      });
    const removed = await Promise.all([remove(), remove()]);
    expect(removed.map((result) => result.statusCode)).toEqual([204, 204]);

    const activeMemberships = await app.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, target.userId), eq(members.status, "active")));
    expect(activeMemberships).toEqual([]);
    const [historicalMirror] = await app.db
      .select({ status: agents.status, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, target.agentId));
    expect(historicalMirror).toMatchObject({ status: "suspended", displayName: "Invite Removed Target" });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${targetTokens.accessToken}` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ code: "invite-required" });
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
