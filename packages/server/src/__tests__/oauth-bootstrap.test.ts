import { googleExternalProfile } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { findOrCreateUserFromExternalAccount } from "../services/auth/identity.js";
import {
  completeExternalAccountBootstrap,
  OAuthBootstrapError,
  shouldPreserveSoloSignupNext,
} from "../services/auth/oauth/bootstrap.js";
import { createPersonalTeam } from "../services/team/membership.js";
import { useTestApp } from "./helpers.js";

describe("provider-neutral OAuth bootstrap", () => {
  const getApp = useTestApp({ googleOAuth: true });

  it("keeps the existing personal-Team bootstrap while Agent-first onboarding is disabled", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-gated-bootstrap-subject", name: "Gated Owner" }),
    );

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next: "/",
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
      agentFirstOnboardingEnabled: false,
    });

    expect(result).toMatchObject({
      joinPath: "solo",
      next: "/",
      organizationId: expect.any(String),
      orgPinned: true,
      teamCreated: true,
    });
    expect(await app.db.select().from(members).where(eq(members.userId, account.userId))).toHaveLength(1);
  });

  it("leaves a solo first sign-in with no Team and preserves the production-scan quickstart", async () => {
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
      agentFirstOnboardingEnabled: true,
    });

    expect(result).toMatchObject({
      joinPath: "solo",
      next,
      organizationId: null,
      // Nothing to activate: there is no Team to pin the SPA to yet.
      orgPinned: false,
      teamCreated: false,
    });
    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, account.userId));
    expect(identity).toMatchObject({ provider: "google", identifier: "google-bootstrap-subject" });

    // The acceptance bar for this change: browsing/signing in solo creates no
    // Team, no membership, and no human mirror.
    const memberships = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(memberships).toEqual([]);
    const teams = await app.db.select().from(organizations).where(eq(organizations.name, account.username));
    expect(teams).toEqual([]);
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
      agentFirstOnboardingEnabled: true,
    });

    expect(result).toMatchObject({ joinPath: "solo", next: "/", organizationId: null });
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
      agentFirstOnboardingEnabled: true,
    });

    expect(result).toMatchObject({ joinPath: "solo", next, organizationId: null });
  });

  it("still requires an invite on an invitation-only server", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-invite-only-subject", name: "Invite Only User" }),
    );
    const team = await createPersonalTeam(app.db, {
      userId: (
        await findOrCreateUserFromExternalAccount(
          app.db,
          googleExternalProfile({ sub: "google-invite-only-host", name: "Invite Only Host" }),
        )
      ).userId,
      username: "invite-only-host",
      teamDisplayName: "Invite Only Host's team",
      userDisplayName: "Invite Only Host",
    });

    await expect(
      completeExternalAccountBootstrap(app.db, account, {
        next: "/",
        allowedOrganizationId: team.organizationId,
        ip: null,
        userAgent: null,
        agentFirstOnboardingEnabled: true,
      }),
    ).rejects.toThrow(OAuthBootstrapError);
    const memberships = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(memberships).toEqual([]);
  });

  it("returns the existing Team for a returning sign-in without pinning it", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-returning-subject", name: "Returning User" }),
    );
    const team = await createPersonalTeam(app.db, {
      userId: account.userId,
      username: account.username,
      teamDisplayName: "Returning User's team",
      userDisplayName: "Returning User",
    });

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next: "/settings/integrations/github",
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
      agentFirstOnboardingEnabled: true,
    });

    expect(result).toMatchObject({
      joinPath: "returning",
      next: "/settings/integrations/github",
      organizationId: team.organizationId,
      orgPinned: false,
    });
  });

  it("creates no Team when concurrent first sign-ins race", async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const app = getApp();
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    const bootstrapInput = {
      next: "/",
      allowedOrganizationId: null,
      ip: null,
      userAgent: "oauth-bootstrap-concurrency-test",
      agentFirstOnboardingEnabled: true,
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
      expect(results.map((result) => result.organizationId)).toEqual([null, null]);

      const [identity] = await app.db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "google-bootstrap-concurrent-subject"));
      expect(identity?.userId).toBe(results[0]?.account.userId);
      const userTeams = await app.db
        .select({ organizationId: members.organizationId })
        .from(members)
        .where(eq(members.userId, results[0]?.account.userId ?? ""));
      expect(userTeams).toEqual([]);
      const humanAgents = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(eq(agents.displayName, "Bootstrap Race 0"));
      expect(humanAgents).toEqual([]);
    } finally {
      await firstDb.end();
      await secondDb.end();
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
