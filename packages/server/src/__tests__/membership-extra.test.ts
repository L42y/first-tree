import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import {
  createPersonalTeam,
  deactivateMembership,
  ensureActiveMembershipOrRepair,
  MEMBER_STATUSES,
  MEMBERSHIP_RECOVERY_POLICIES,
} from "../services/team/membership.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("membership service edge coverage", () => {
  const getApp = useTestApp();

  it("rejects deactivation when the membership is already in a different inactive state", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `membership-state-${crypto.randomUUID().slice(0, 8)}` });

    await deactivateMembership(
      app.db,
      admin.memberId,
      MEMBER_STATUSES.REMOVED,
      MEMBERSHIP_RECOVERY_POLICIES.PERSONAL_TEAM,
    );

    await expect(
      deactivateMembership(app.db, admin.memberId, MEMBER_STATUSES.LEFT, MEMBERSHIP_RECOVERY_POLICIES.PERSONAL_TEAM),
    ).rejects.toThrow(/not active/);
  });

  it("discriminates account suspension from an invitation-required zero-membership boundary", async () => {
    const app = getApp();
    const suspended = await createAdminContext(app, { username: `inactive-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));
    expect(
      await ensureActiveMembershipOrRepair(app.db, suspended.userId, MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED),
    ).toEqual({ kind: "account-inactive" });

    const invitee = await createAdminContext(app, { username: `invite-only-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(members).set({ status: MEMBER_STATUSES.REMOVED }).where(eq(members.userId, invitee.userId));
    expect(
      await ensureActiveMembershipOrRepair(app.db, invitee.userId, MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED),
    ).toEqual({ kind: "invitation-required" });
  });

  it("falls back to a uuid-based organization slug after repeated insert collisions", async () => {
    let organizationInsertAttempts = 0;
    const insertedOrganizationNames: string[] = [];
    const insertedMembers: Record<string, unknown>[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              organizationInsertAttempts += 1;
              if (organizationInsertAttempts <= 4) return [];
              if (typeof value.name === "string") insertedOrganizationNames.push(value.name);
              return [{ name: value.name }];
            },
          }),
        }),
      }),
      transaction: async (callback: (tx: unknown) => Promise<Record<string, unknown>>) => {
        return callback({
          select: () => ({
            from: () => ({
              where: () =>
                Object.assign(Promise.resolve([]), {
                  for: () => ({ limit: async () => [{ id: "user-1", displayName: "Retry User" }] }),
                  limit: async () => [],
                  orderBy: async () => [],
                }),
            }),
          }),
          insert: () => ({
            values: (value: Record<string, unknown>) => {
              if (typeof value.name === "string" && !("type" in value)) {
                return {
                  onConflictDoNothing: () => ({
                    returning: async () => {
                      organizationInsertAttempts += 1;
                      if (organizationInsertAttempts <= 4) return [];
                      insertedOrganizationNames.push(value.name as string);
                      return [{ name: value.name }];
                    },
                  }),
                };
              }
              return {
                returning: async () => {
                  insertedMembers.push(value);
                  return [
                    {
                      id: "member-1",
                      userId: value.userId,
                      organizationId: value.organizationId,
                      agentId: value.agentId,
                      role: value.role,
                      status: value.status,
                    },
                  ];
                },
              };
            },
          }),
          update: () => ({
            set: () => ({ where: async () => [] }),
          }),
        });
      },
    };

    await expect(
      createPersonalTeam(fakeDb as never, {
        userId: "user-1",
        username: "Retry User",
        teamDisplayName: "Retry User's team",
        userDisplayName: "Retry User",
      }),
    ).resolves.toMatchObject({
      slug: expect.stringMatching(/^retry-user-[0-9a-f-]{12}$/),
      memberId: "member-1",
    });

    expect(organizationInsertAttempts).toBe(5);
    expect(insertedOrganizationNames).toHaveLength(1);
    expect(insertedMembers).toHaveLength(1);
  });
});
