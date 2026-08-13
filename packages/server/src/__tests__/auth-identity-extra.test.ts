import { githubExternalProfile, googleExternalProfile } from "@first-tree/shared";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { requireAgent } from "../middleware/require-identity.js";
import { requireUser } from "../scope/require-user.js";
import {
  findOrCreateGithubAccount,
  findOrCreateUserFromExternalAccount,
  findOrCreateUserFromGithub,
  getStoredGithubAccessToken,
  hasUsableAuthentication,
  IdentityConflictError,
  IdentityMismatchError,
  isUsableLegacyPasswordHash,
  LastIdentityError,
  linkExternalIdentity,
  refreshGithubInstallIdentity,
  unlinkExternalIdentity,
} from "../services/auth/identity.js";
import { encryptValue } from "../services/crypto.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const ENCRYPTION_KEY = "0".repeat(64);

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

describe("auth identity extra coverage", () => {
  const getApp = useTestApp();

  it("throws clean authentication errors when required identities are missing", () => {
    expect(() => requireAgent({} as never)).toThrow("Agent authentication required");
    expect(() => requireUser({} as never)).toThrow("User authentication required");
  });

  it("creates GitHub identities with username retry and refreshes stored token metadata", async () => {
    const app = getApp();
    await app.db.insert(users).values({
      id: uuidv7(),
      username: "octocat",
      passwordHash: "x",
      displayName: "Existing Octocat",
    });

    const created = await findOrCreateUserFromGithub(app.db, {
      githubId: "gh-100",
      login: "Octocat",
      email: null,
      displayName: "  ",
      avatarUrl: "https://avatars.example/octo.png",
    });

    const [user] = await app.db.select().from(users).where(eq(users.id, created.userId)).limit(1);
    expect(user?.username).toMatch(/^octocat-[0-9a-f]{4}$/);
    expect(user?.displayName).toBe("octocat");
    expect(user?.avatarUrl).toBe("https://avatars.example/octo.png");
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBeNull();

    const encryptedAccessToken = encryptValue("gho_access", ENCRYPTION_KEY);
    const encryptedRefreshToken = encryptValue("ghr_refresh", ENCRYPTION_KEY);
    const existing = await findOrCreateUserFromGithub(
      app.db,
      {
        githubId: "gh-100",
        login: "renamed-octocat",
        email: "octo@example.com",
        displayName: "Renamed Octo",
        avatarUrl: null,
      },
      {
        encryptedAccessToken,
        accessTokenExpiresAt: "2026-07-08T00:00:00.000Z",
        encryptedRefreshToken,
        refreshTokenExpiresAt: "2026-08-08T00:00:00.000Z",
      },
    );

    expect(existing.userId).toBe(created.userId);
    const [identity] = await app.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, created.userId))
      .limit(1);
    expect(identity).toMatchObject({
      provider: "github",
      identifier: "gh-100",
      email: "octo@example.com",
    });
    expect(identity?.metadata).toMatchObject({
      login: "renamed-octocat",
      accessToken: encryptedAccessToken,
      accessTokenExpiresAt: "2026-07-08T00:00:00.000Z",
      refreshToken: encryptedRefreshToken,
      refreshTokenExpiresAt: "2026-08-08T00:00:00.000Z",
    });
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBe("gho_access");

    await app.db
      .update(authIdentities)
      .set({ metadata: { accessToken: "enc:v1:not-base64" } })
      .where(eq(authIdentities.userId, created.userId));
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBeNull();
    await expect(getStoredGithubAccessToken(app.db, "missing-user", ENCRYPTION_KEY)).resolves.toBeNull();
  });

  it("keeps GitHub, Google, and OIDC identity snapshots immutable while their account is suspended", async () => {
    const app = getApp();
    const suffix = crypto.randomUUID();
    const github = await findOrCreateGithubAccount(
      app.db,
      {
        githubId: `gh-suspended-${suffix}`,
        login: "github-before",
        email: "github-before@example.com",
        displayName: "GitHub Before",
        avatarUrl: "https://avatars.example/before.png",
      },
      { encryptedAccessToken: "encrypted-github-before" },
    );
    const google = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({
        sub: `google-suspended-${suffix}`,
        name: "Google Before",
        email: "google-before@example.com",
        emailVerified: true,
        picture: "https://avatars.example/google-before.png",
      }),
    );
    const oidcSubject = JSON.stringify(["https://issuer.example", `oidc-suspended-${suffix}`]);
    const oidc = await findOrCreateUserFromExternalAccount(app.db, {
      provider: "oidc",
      subject: oidcSubject,
      usernameCandidates: ["oidc-before"],
      displayName: "OIDC Before",
      email: "oidc-before@example.com",
      avatarUrl: "https://avatars.example/oidc-before.png",
      metadata: { issuer: "https://issuer.example", sub: `oidc-suspended-${suffix}`, marker: "before" },
    });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, github.userId));
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, google.userId));
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, oidc.userId));
    const before = await app.db
      .select({
        userId: authIdentities.userId,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        updatedAt: authIdentities.updatedAt,
      })
      .from(authIdentities)
      .where(eq(authIdentities.provider, "github"));
    const githubBefore = before.find((identity) => identity.userId === github.userId);
    const [googleBefore] = await app.db
      .select({
        userId: authIdentities.userId,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        updatedAt: authIdentities.updatedAt,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, google.userId));
    const [oidcBefore] = await app.db
      .select({
        userId: authIdentities.userId,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        updatedAt: authIdentities.updatedAt,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, oidc.userId));

    await findOrCreateGithubAccount(
      app.db,
      {
        githubId: `gh-suspended-${suffix}`,
        login: "github-after",
        email: "github-after@example.com",
        displayName: "GitHub After",
        avatarUrl: "https://avatars.example/after.png",
      },
      { encryptedAccessToken: "encrypted-github-after", encryptedRefreshToken: "encrypted-refresh-after" },
    );
    await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({
        sub: `google-suspended-${suffix}`,
        name: "Google After",
        email: "google-after@example.com",
        emailVerified: true,
        picture: "https://avatars.example/google-after.png",
      }),
    );
    await findOrCreateUserFromExternalAccount(app.db, {
      provider: "oidc",
      subject: oidcSubject,
      usernameCandidates: ["oidc-after"],
      displayName: "OIDC After",
      email: "oidc-after@example.com",
      avatarUrl: "https://avatars.example/oidc-after.png",
      metadata: { issuer: "https://issuer.example", sub: `oidc-suspended-${suffix}`, marker: "after" },
    });

    const after = await app.db
      .select({
        userId: authIdentities.userId,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        updatedAt: authIdentities.updatedAt,
      })
      .from(authIdentities);
    expect(after.find((identity) => identity.userId === github.userId)).toEqual(githubBefore);
    expect(after.find((identity) => identity.userId === google.userId)).toEqual(googleBefore);
    expect(after.find((identity) => identity.userId === oidc.userId)).toEqual(oidcBefore);
  });

  it("rejects a suspended GitHub installation refresh without mutating its stored credential snapshot", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `install-suspended-${crypto.randomUUID().slice(0, 8)}` });
    await linkExternalIdentity(
      app.db,
      admin.userId,
      githubExternalProfile({
        id: "github-install-suspended",
        login: "install-before",
        email: "install-before@example.com",
        metadata: { accessToken: "encrypted-install-before" },
      }),
    );
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, admin.userId));
    const [before] = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, admin.userId));

    const result = await refreshGithubInstallIdentity(app.db, {
      userId: admin.userId,
      organizationId: admin.organizationId,
      profile: {
        githubId: "github-install-suspended",
        login: "install-after",
        email: "install-after@example.com",
        displayName: "Install After",
        avatarUrl: "https://avatars.example/install-after.png",
      },
      tokens: { encryptedAccessToken: "encrypted-install-after", encryptedRefreshToken: "refresh-after" },
    });

    expect(result).toMatchObject({ ok: false, reason: "not-admin" });
    const [after] = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, admin.userId));
    expect(after).toEqual(before);
  });

  it("falls back to a uuid-based username suffix after repeated unique violations", async () => {
    let transactionAttempts = 0;
    const insertedUsernames: string[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      transaction: async (callback: (tx: unknown) => Promise<void>) => {
        transactionAttempts += 1;
        if (transactionAttempts <= 4) {
          const err = new Error("duplicate username") as Error & { code: string; constraint_name: string };
          err.code = "23505";
          err.constraint_name = "users_username_unique";
          throw err;
        }
        await callback({
          insert: () => ({
            values: async (value: Record<string, unknown>) => {
              if (typeof value.username === "string") insertedUsernames.push(value.username);
            },
          }),
        });
      },
    };

    await expect(
      findOrCreateUserFromGithub(fakeDb as never, {
        githubId: "gh-retry",
        login: "retry",
        email: null,
        displayName: null,
        avatarUrl: null,
      }),
    ).resolves.toEqual({ userId: expect.any(String) });

    expect(transactionAttempts).toBe(5);
    expect(insertedUsernames).toHaveLength(1);
    expect(insertedUsernames[0]).toMatch(/^retry-[0-9a-f-]{12}$/);
  });

  it("converges concurrent sign-ins for one external subject onto one user", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    try {
      const profileA = githubExternalProfile({
        id: "gh-concurrent-sign-in",
        login: "race-a",
        name: "Race A",
        email: null,
      });
      const profileB = githubExternalProfile({
        id: "gh-concurrent-sign-in",
        login: "race-b",
        name: "Race B",
        email: null,
      });
      const results = await Promise.all([
        findOrCreateUserFromExternalAccount(firstDb, profileA),
        findOrCreateUserFromExternalAccount(secondDb, profileB),
      ]);

      expect(results[0]?.userId).toBe(results[1]?.userId);
      const usersForIdentity = await app.db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "gh-concurrent-sign-in"));
      expect(usersForIdentity).toEqual([{ userId: results[0]?.userId }]);
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("maps concurrent identity-link races to idempotence or conflict", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    const firstUserId = uuidv7();
    const secondUserId = uuidv7();
    const sameBindingUserId = uuidv7();
    const providerRaceUserId = uuidv7();
    try {
      await app.db.insert(users).values([
        { id: firstUserId, username: "link-race-a", passwordHash: "x", displayName: "Link Race A" },
        { id: secondUserId, username: "link-race-b", passwordHash: "x", displayName: "Link Race B" },
        { id: sameBindingUserId, username: "link-race-same", passwordHash: "x", displayName: "Link Race Same" },
        { id: providerRaceUserId, username: "link-race-c", passwordHash: "x", displayName: "Link Race C" },
      ]);
      const sharedProfile = githubExternalProfile({
        id: "gh-concurrent-link",
        login: "concurrent-link",
        name: "Concurrent Link",
        email: null,
      });
      const subjectRace = await Promise.allSettled([
        linkExternalIdentity(firstDb, firstUserId, sharedProfile),
        linkExternalIdentity(secondDb, secondUserId, sharedProfile),
      ]);
      expect(subjectRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(subjectRace.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(
        IdentityConflictError,
      );

      const sameBindingProfile = githubExternalProfile({
        id: "gh-concurrent-same-binding",
        login: "same-binding",
      });
      const sameBindingRace = await Promise.all([
        linkExternalIdentity(firstDb, sameBindingUserId, sameBindingProfile),
        linkExternalIdentity(secondDb, sameBindingUserId, sameBindingProfile),
      ]);
      expect(sameBindingRace.sort()).toEqual(["already-linked", "linked"]);

      const providerRace = await Promise.allSettled([
        linkExternalIdentity(
          firstDb,
          providerRaceUserId,
          githubExternalProfile({ id: "gh-provider-a", login: "provider-a" }),
        ),
        linkExternalIdentity(
          secondDb,
          providerRaceUserId,
          githubExternalProfile({ id: "gh-provider-b", login: "provider-b" }),
        ),
      ]);
      expect(providerRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(providerRace.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(
        IdentityConflictError,
      );
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("rejects a unique-conflict fallback after suspension wins the stable user fence", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const target = await createTestAdmin(app, { username: `link-fallback-suspend-${crypto.randomUUID().slice(0, 8)}` });
    const subject = `gh-link-fallback-${crypto.randomUUID()}`;
    const profile = githubExternalProfile({
      id: subject,
      login: "stale-fallback-profile",
      metadata: { marker: "stale-fallback" },
    });
    const linkApplicationName = `identity_link_${crypto.randomUUID().slice(0, 8)}`;
    const suspensionApplicationName = `identity_suspend_${crypto.randomUUID().slice(0, 8)}`;
    const linkDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, linkApplicationName));
    const suspensionDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, suspensionApplicationName));
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const winnerId = uuidv7();
    let blockerCommitted = false;
    try {
      await blocker`BEGIN`;
      await blocker`
        INSERT INTO auth_identities (id, user_id, provider, identifier, metadata)
        VALUES (${winnerId}, ${target.userId}, 'github', ${subject}, ${JSON.stringify({ marker: "winner" })}::jsonb)
      `;

      const linking = linkExternalIdentity(linkDb, target.userId, profile).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForPostgresLockWait(observer, linkApplicationName);
      const suspension = Promise.resolve(
        suspensionDb.update(users).set({ status: "suspended" }).where(eq(users.id, target.userId)),
      );
      await waitForPostgresLockWait(observer, suspensionApplicationName);

      await blocker`COMMIT`;
      blockerCommitted = true;
      await suspension;
      const result = await linking;

      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.error).toMatchObject({ message: expect.stringMatching(/suspended/i) });
      const [stored] = await app.db
        .select({ metadata: authIdentities.metadata })
        .from(authIdentities)
        .where(eq(authIdentities.id, winnerId));
      expect(stored?.metadata).toEqual({ marker: "winner" });
    } finally {
      if (!blockerCommitted) await blocker`ROLLBACK`;
      await linkDb.end();
      await suspensionDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("protects the last usable credential when provider configuration changes", async () => {
    const app = getApp();
    const oauthOnlyUserId = uuidv7();
    const legacyUserId = uuidv7();
    const googleOnlyIdentityId = uuidv7();
    const githubDisabledIdentityId = uuidv7();
    const legacyIdentityId = uuidv7();
    await app.db.insert(users).values([
      { id: oauthOnlyUserId, username: "oauth-only", passwordHash: "x", displayName: "OAuth Only" },
      {
        id: legacyUserId,
        username: "legacy-password",
        passwordHash: await bcrypt.hash("legacy", 1),
        displayName: "Legacy",
      },
    ]);
    await app.db.insert(authIdentities).values([
      {
        id: googleOnlyIdentityId,
        userId: oauthOnlyUserId,
        provider: "google",
        identifier: "google-only",
        metadata: {},
      },
      {
        id: githubDisabledIdentityId,
        userId: oauthOnlyUserId,
        provider: "github",
        identifier: "github-disabled",
        metadata: {},
      },
      {
        id: legacyIdentityId,
        userId: legacyUserId,
        provider: "google",
        identifier: "google-legacy",
        metadata: {},
      },
    ]);

    expect(isUsableLegacyPasswordHash("x")).toBe(false);
    expect(isUsableLegacyPasswordHash("not-a-bcrypt-hash")).toBe(false);
    expect(
      hasUsableAuthentication(
        [{ provider: "github", identifier: "github-disabled", credentialType: null }],
        "x",
        { google: true, github: false, oidc: false },
        "google",
      ),
    ).toBe(false);

    await expect(
      unlinkExternalIdentity(
        app.db,
        oauthOnlyUserId,
        "google",
        "google-only",
        { google: true, github: false, oidc: false },
        googleOnlyIdentityId,
      ),
    ).rejects.toBeInstanceOf(LastIdentityError);

    const replacementIdentityId = uuidv7();
    await app.db.delete(authIdentities).where(eq(authIdentities.id, googleOnlyIdentityId));
    await app.db.insert(authIdentities).values({
      id: replacementIdentityId,
      userId: oauthOnlyUserId,
      provider: "google",
      identifier: "google-replacement",
      metadata: {},
    });
    await expect(
      unlinkExternalIdentity(
        app.db,
        oauthOnlyUserId,
        "google",
        "google-replacement",
        { google: true, github: true, oidc: false },
        googleOnlyIdentityId,
      ),
    ).rejects.toBeInstanceOf(IdentityMismatchError);
    await expect(
      app.db.select().from(authIdentities).where(eq(authIdentities.id, replacementIdentityId)),
    ).resolves.toHaveLength(1);
    await expect(
      unlinkExternalIdentity(
        app.db,
        legacyUserId,
        "google",
        "google-legacy",
        { google: true, github: false, oidc: false },
        legacyIdentityId,
      ),
    ).resolves.toBeUndefined();
  });
});
