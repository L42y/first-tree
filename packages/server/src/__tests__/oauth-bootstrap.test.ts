import { googleExternalProfile } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { invitationRedemptions } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { findOrCreateUserFromExternalAccount } from "../services/auth/identity.js";
import {
  completeExternalAccountBootstrap,
  OAuthBootstrapError,
  shouldPreserveSoloSignupNext,
} from "../services/auth/oauth/bootstrap.js";
import { rotateInvitation } from "../services/team/invitation.js";
import { deactivateMembership, MEMBER_STATUSES, MEMBERSHIP_RECOVERY_POLICIES } from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { useTestApp } from "./helpers.js";
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
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

describe("provider-neutral OAuth bootstrap", () => {
  const getApp = useTestApp({ googleOAuth: true });

  it("creates the full personal team graph for Google and preserves production-scan quickstart", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({
        sub: "google-bootstrap-subject",
        email: "Workspace.Owner@example.com",
        emailVerified: true,
        name: "Workspace Owner",
      }),
    );
    const next = `/quickstart?campaign=production-scan&repo=${encodeURIComponent("https://github.com/acme/backend")}`;

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next,
      allowedOrganizationId: null,
      ip: "127.0.0.1",
      userAgent: "oauth-bootstrap-test",
    });

    expect(result).toMatchObject({
      joinPath: "solo",
      next,
      orgPinned: true,
      teamCreated: true,
    });
    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, account.userId));
    expect(identity).toMatchObject({ provider: "google", identifier: "google-bootstrap-subject" });

    const [organization] = await app.db.select().from(organizations).where(eq(organizations.id, result.organizationId));
    expect(organization).toMatchObject({
      name: "workspace-owner",
      displayName: "Workspace Owner's team",
    });

    const [membership] = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(membership).toMatchObject({
      organizationId: result.organizationId,
      role: "admin",
      status: "active",
    });
    const [humanAgent] = await app.db
      .select()
      .from(agents)
      .where(eq(agents.uuid, membership?.agentId ?? ""));
    expect(humanAgent).toMatchObject({
      name: "workspace-owner",
      displayName: "Workspace Owner",
      type: "human",
    });
  });

  it("resets an ordinary first-sign-in destination to onboarding entry", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-settings-subject", name: "Settings User" }),
    );

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next: "/settings/integrations/github",
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
    });

    expect(result).toMatchObject({ joinPath: "solo", next: "/", teamCreated: true });
  });

  it("repairs a returning external account whose final membership was lost", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-returning-repair-${crypto.randomUUID()}`, name: "Returning Repair" }),
    );
    const first = await completeExternalAccountBootstrap(app.db, account, {
      next: "/",
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
    });
    const [original] = await app.db
      .select()
      .from(members)
      .where(and(eq(members.userId, account.userId), eq(members.organizationId, first.organizationId)));
    if (!original) throw new Error("Expected bootstrap membership");
    await deactivateMembership(
      app.db,
      original.id,
      MEMBER_STATUSES.REMOVED,
      MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED,
    );

    const repaired = await completeExternalAccountBootstrap(
      app.db,
      { ...account, created: false },
      {
        next: "/settings",
        allowedOrganizationId: null,
        ip: null,
        userAgent: null,
      },
    );

    expect(repaired).toMatchObject({ joinPath: "solo", next: "/", teamCreated: true });
    expect(repaired.organizationId).not.toBe(first.organizationId);
    const membershipRows = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(membershipRows.filter((membership) => membership.status === MEMBER_STATUSES.ACTIVE)).toHaveLength(1);
    expect(membershipRows.find((membership) => membership.id === original.id)?.status).toBe(MEMBER_STATUSES.REMOVED);
    const mirrorRows = await app.db.select().from(agents).where(eq(agents.uuid, original.agentId));
    expect(mirrorRows[0]).toMatchObject({ status: "suspended", displayName: "Returning Repair" });
  });

  it("keeps a returning zero-membership account at the invitation boundary", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-returning-invite-${crypto.randomUUID()}`, name: "Returning Invite" }),
    );

    await expect(
      completeExternalAccountBootstrap(
        app.db,
        { ...account, created: false },
        {
          next: "/settings",
          allowedOrganizationId: DEFAULT_ORG_ID,
          ip: null,
          userAgent: null,
        },
      ),
    ).rejects.toEqual(new OAuthBootstrapError("invite-required"));
    const membershipRows = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(membershipRows).toHaveLength(0);
  });

  it("rejects a suspended account before invitation redemption or Team repair", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-suspended-${crypto.randomUUID()}`, name: "Suspended Account" }),
    );
    const invitation = await rotateInvitation(app.db, DEFAULT_ORG_ID, account.userId);
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, account.userId));

    await expect(
      completeExternalAccountBootstrap(
        app.db,
        { ...account, created: false },
        {
          next: `/invite/${invitation.token}`,
          allowedOrganizationId: DEFAULT_ORG_ID,
          ip: null,
          userAgent: null,
        },
      ),
    ).rejects.toEqual(new OAuthBootstrapError("account-inactive"));

    expect(await app.db.select().from(members).where(eq(members.userId, account.userId))).toHaveLength(0);
    expect(
      await app.db.select().from(invitationRedemptions).where(eq(invitationRedemptions.userId, account.userId)),
    ).toHaveLength(0);
  });

  it("requires admin restore for a removed membership without consuming a fresh invite", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-removed-${crypto.randomUUID()}`, name: "Removed Account" }),
    );
    const invitation = await rotateInvitation(app.db, DEFAULT_ORG_ID, account.userId);
    const joined = await completeExternalAccountBootstrap(app.db, account, {
      next: `/invite/${invitation.token}`,
      allowedOrganizationId: DEFAULT_ORG_ID,
      ip: null,
      userAgent: null,
    });
    const [stableMember] = await app.db.select().from(members).where(eq(members.userId, account.userId));
    if (!stableMember) throw new Error("Expected invited membership");
    await deactivateMembership(
      app.db,
      stableMember.id,
      MEMBER_STATUSES.REMOVED,
      MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED,
    );

    await expect(
      completeExternalAccountBootstrap(
        app.db,
        { ...account, created: false },
        {
          next: `/invite/${invitation.token}`,
          allowedOrganizationId: DEFAULT_ORG_ID,
          ip: null,
          userAgent: null,
        },
      ),
    ).rejects.toEqual(new OAuthBootstrapError("membership-restore-required"));

    const [after] = await app.db.select().from(members).where(eq(members.id, stableMember.id));
    expect(after).toMatchObject({
      id: stableMember.id,
      agentId: stableMember.agentId,
      status: MEMBER_STATUSES.REMOVED,
    });
    expect(joined.organizationId).toBe(DEFAULT_ORG_ID);
    expect(
      await app.db.select().from(invitationRedemptions).where(eq(invitationRedemptions.userId, account.userId)),
    ).toHaveLength(1);
  });

  it("lets a self-left invitee rejoin with the stable membership and mirror identity", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-left-${crypto.randomUUID()}`, name: "Self Left Account" }),
    );
    const invitation = await rotateInvitation(app.db, DEFAULT_ORG_ID, account.userId);
    await completeExternalAccountBootstrap(app.db, account, {
      next: `/invite/${invitation.token}`,
      allowedOrganizationId: DEFAULT_ORG_ID,
      ip: null,
      userAgent: null,
    });
    const [stableMember] = await app.db.select().from(members).where(eq(members.userId, account.userId));
    if (!stableMember) throw new Error("Expected invited membership");
    await deactivateMembership(
      app.db,
      stableMember.id,
      MEMBER_STATUSES.LEFT,
      MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED,
    );

    const rejoined = await completeExternalAccountBootstrap(
      app.db,
      { ...account, created: false },
      {
        next: `/invite/${invitation.token}`,
        allowedOrganizationId: DEFAULT_ORG_ID,
        ip: null,
        userAgent: null,
      },
    );
    const [after] = await app.db.select().from(members).where(eq(members.id, stableMember.id));
    expect(rejoined.joinPath).toBe("invite");
    expect(after).toMatchObject({ id: stableMember.id, agentId: stableMember.agentId, status: MEMBER_STATUSES.ACTIVE });
  });

  it("preserves a strict Agent Template intent across solo signup", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-template-intent-subject", name: "Template Intent User" }),
    );
    const next = "/templates/pr-engineer?use=1";

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next,
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
    });

    expect(result).toMatchObject({ joinPath: "solo", next, teamCreated: true });
  });

  it("serializes concurrent first sign-ins into one personal team graph", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    const bootstrapInput = {
      next: "/",
      allowedOrganizationId: null,
      ip: null,
      userAgent: "oauth-bootstrap-concurrency-test",
    };
    try {
      const results = await Promise.all(
        [firstDb, secondDb].map(async (db, index) => {
          const account = await findOrCreateUserFromExternalAccount(
            db,
            googleExternalProfile({
              sub: "google-bootstrap-concurrent-subject",
              email: `bootstrap-race-${index}@example.com`,
              emailVerified: true,
              name: `Bootstrap Race ${index}`,
            }),
          );
          return completeExternalAccountBootstrap(db, account, bootstrapInput);
        }),
      );

      expect(results[0]?.account.userId).toBe(results[1]?.account.userId);
      expect(results[0]?.organizationId).toBe(results[1]?.organizationId);
      expect(results.map((result) => result.teamCreated).sort()).toEqual([false, true]);

      const [identity] = await app.db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "google-bootstrap-concurrent-subject"));
      expect(identity?.userId).toBe(results[0]?.account.userId);
      const userTeams = await app.db
        .select({ organizationId: members.organizationId })
        .from(members)
        .where(eq(members.userId, results[0]?.account.userId ?? ""));
      expect(userTeams).toHaveLength(1);
      const teams = await app.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, results[0]?.organizationId ?? ""));
      expect(teams).toHaveLength(1);
      const humanAgents = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(eq(agents.organizationId, results[0]?.organizationId ?? ""));
      expect(humanAgents).toHaveLength(1);
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("recovers from a slug conflict that arrives after the pre-check", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const bootstrapApplicationName = `oauth_bootstrap_${crypto.randomUUID().slice(0, 8)}`;
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const bootstrapDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, bootstrapApplicationName));
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: `google-slug-race-${crypto.randomUUID()}`, name: "Slug Race" }),
    );
    const slug = account.username;
    const heldOrganizationId = uuidv7();
    let releaseBlocker = (): void => undefined;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerInserted = (): void => undefined;
    const blockerReady = new Promise<void>((resolve) => {
      blockerInserted = resolve;
    });
    try {
      const blockerTransaction = blocker.begin(async (tx) => {
        await tx.unsafe("INSERT INTO organizations (id, name, display_name) VALUES ($1, $2, $3)", [
          heldOrganizationId,
          slug,
          "Held slug",
        ]);
        blockerInserted();
        await blockerRelease;
      });
      await blockerReady;

      const bootstrapPromise = completeExternalAccountBootstrap(bootstrapDb, account, {
        next: "/",
        allowedOrganizationId: null,
        ip: null,
        userAgent: "oauth-slug-race-test",
      });
      await waitForPostgresLockWait(observer, bootstrapApplicationName);
      releaseBlocker();
      await blockerTransaction;
      const result = await bootstrapPromise;

      expect(result.teamCreated).toBe(true);
      expect(result.organizationId).not.toBe(heldOrganizationId);
      expect(result.organizationId).not.toBe("");
      const [organization] = await app.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, result.organizationId));
      expect(organization?.name).toMatch(new RegExp(`^${slug}-[0-9a-f]{4}$`));
    } finally {
      releaseBlocker();
      await bootstrapDb.end();
      await blocker.end();
      await observer.end();
    }
  });
});

describe("shouldPreserveSoloSignupNext", () => {
  it("keeps the known-campaign quickstart next", () => {
    expect(
      shouldPreserveSoloSignupNext("/quickstart?campaign=production-scan&repo=https%3A%2F%2Fexample.com%2Fr"),
    ).toBe(true);
  });

  it("preserves only the strict Template intent URL", () => {
    expect(shouldPreserveSoloSignupNext("/templates/pr-engineer?use=1")).toBe(true);
    // Invalid slug.
    expect(shouldPreserveSoloSignupNext("/templates/PR_Engineer?use=1")).toBe(false);
    // Extra query parameters.
    expect(shouldPreserveSoloSignupNext("/templates/pr-engineer?use=1&campaign=production-scan")).toBe(false);
    // Missing / wrong intent flag.
    expect(shouldPreserveSoloSignupNext("/templates/pr-engineer")).toBe(false);
    expect(shouldPreserveSoloSignupNext("/templates/pr-engineer?use=0")).toBe(false);
    // Fragment.
    expect(shouldPreserveSoloSignupNext("/templates/pr-engineer?use=1#details")).toBe(false);
    // Anything else, including ordinary deep links.
    expect(shouldPreserveSoloSignupNext("/settings/integrations/github")).toBe(false);
    expect(shouldPreserveSoloSignupNext("/")).toBe(false);
    expect(shouldPreserveSoloSignupNext("/templates")).toBe(false);
  });
});
