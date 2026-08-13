import { eq } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { signTokensForUser } from "../services/auth/tokens.js";
import { deactivateMembership, MEMBER_STATUSES, MEMBERSHIP_RECOVERY_POLICIES } from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForMeLifecycleLock(
  observer: ReturnType<typeof postgres>,
  removalApplicationName: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ application_name: string; wait_event_type: string | null; query: string }[]>`
      SELECT application_name, wait_event_type, query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name <> ${removalApplicationName}
        AND wait_event_type = 'Lock'
        AND query ILIKE '%from "users"%'
        AND query ILIKE '%for no key update%'
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for /me lifecycle lock");
}

async function waitForApplicationLock(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
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

describe("GET /api/v1/me", () => {
  const getApp = useTestApp();

  it("returns current user + memberships + default org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      user: { id: string; username: string; displayName: string };
      memberships: Array<{ id: string; organizationId: string; role: string; agentId: string }>;
      defaultOrganizationId: string | null;
    }>();

    expect(body.user).toBeDefined();
    expect(body.user.username).toBe(admin.username);
    expect(body.memberships.length).toBeGreaterThanOrEqual(1);
    expect(body.memberships[0]?.role).toBe("admin");
    expect(body.memberships[0]?.agentId).toBeDefined();
    expect(body.defaultOrganizationId).toBe(body.memberships[0]?.organizationId);
  });

  it("rejects an unexpected authenticated zero-membership account at the repair boundary", async () => {
    const app = getApp();
    const userId = uuidv7();
    await app.db.insert(users).values({
      id: userId,
      username: `me-no-membership-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "test",
      displayName: "No Membership",
    });
    const tokens = await signTokensForUser(TEST_JWT_SECRET, userId, {
      accessTokenExpiry: "30m",
      refreshTokenExpiry: "30d",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "membership-repair-required" });
  });

  it("never returns a membership revoked while /me is constructing its response", async () => {
    const app = getApp();
    const account = await createTestAdmin(app, { username: `me-race-${crypto.randomUUID().slice(0, 8)}` });
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const removalApplicationName = `me_removal_${crypto.randomUUID().slice(0, 8)}`;
    const removalDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, removalApplicationName));
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
      const blockingTransaction = blocker.begin(async (tx) => {
        await tx.unsafe("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [account.userId]);
        blockerReady();
        await blockerRelease;
      });
      await ready;

      const removal = deactivateMembership(
        removalDb,
        account.memberId,
        MEMBER_STATUSES.REMOVED,
        MEMBERSHIP_RECOVERY_POLICIES.PERSONAL_TEAM,
      );
      await waitForApplicationLock(observer, removalApplicationName);

      const meResponse = app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${account.accessToken}` },
      });
      await waitForMeLifecycleLock(observer, removalApplicationName);
      releaseBlocker();
      await blockingTransaction;
      await removal;
      const response = await meResponse;

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "membership-changed" });
      const liveRows = await app.db.select({ id: members.id }).from(members).where(eq(members.userId, account.userId));
      expect(liveRows.some((row) => row.id === account.memberId)).toBe(true);
    } finally {
      releaseBlocker();
      await removalDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("rejects unauthenticated request", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("first Team provisioning surface", () => {
  const getApp = useTestApp();

  /**
   * Sign-in owns the personal Team, so nothing creates a Team together with a
   * first Agent; Agent creation is Team-scoped (`POST /orgs/:orgId/agents`) for
   * every caller. Routing resolves before auth, so this is a tripwire against
   * re-registering that exact path — not a claim about behavior. What the
   * invariant itself rests on is asserted in `oauth-bootstrap.test.ts`.
   */
  it("does not route the retired user-scoped first-Team Agent path", async () => {
    const app = getApp();

    const res = await app.inject({ method: "POST", url: "/api/v1/me/team-agents" });

    expect(res.statusCode).toBe(404);
  });

  it("keeps physical Team deletion and account deletion/reactivation outside the current HTTP contract", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const headers = { authorization: `Bearer ${admin.accessToken}` };

    const teamDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${admin.organizationId}`,
      headers,
    });
    const teamReactivate = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/reactivate`,
      headers,
    });
    const accountDelete = await app.inject({ method: "DELETE", url: "/api/v1/me/account", headers });
    const accountReactivate = await app.inject({ method: "POST", url: "/api/v1/me/account/reactivate", headers });

    expect(teamDelete.statusCode).toBe(404);
    expect(teamReactivate.statusCode).toBe(404);
    expect(accountDelete.statusCode).toBe(404);
    expect(accountReactivate.statusCode).toBe(404);
  });
});
