import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { broadcastToAdmins } from "../services/admin-broadcast.js";
import { signTokensForUser } from "../services/auth/tokens.js";
import { createMember } from "../services/team/member.js";
import { createTestAdmin, createTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

type MembershipChangedFrame = {
  type: "membership:changed";
  memberId: string;
  organizationId: string;
};

async function listenApp(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return `ws://127.0.0.1:${address.port}/api/v1/orgs`;
}

function openAdminSocket(baseUrl: string, token: string, organizationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/${encodeURIComponent(organizationId)}/ws/?token=${encodeURIComponent(token)}`);
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type !== "admin:connected") return;
      ws.off("message", onMessage);
      resolve(ws);
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
  });
}

function waitForMembershipClose(ws: WebSocket): Promise<{ frame: MembershipChangedFrame; code: number }> {
  return new Promise((resolve, reject) => {
    let frame: MembershipChangedFrame | null = null;
    const timeout = setTimeout(() => reject(new Error("timed out waiting for membership WS close")), 5_000);
    ws.on("message", (raw) => {
      const candidate = JSON.parse(raw.toString()) as Partial<MembershipChangedFrame>;
      if (candidate.type === "membership:changed") frame = candidate as MembershipChangedFrame;
    });
    ws.once("close", (code) => {
      clearTimeout(timeout);
      if (!frame) {
        reject(new Error("membership socket closed without membership:changed frame"));
        return;
      }
      resolve({ frame, code });
    });
  });
}

function observeHandshakeClose(
  baseUrl: string,
  token: string,
  organizationId: string,
): Promise<{ code: number; frameTypes: string[] }> {
  return new Promise((resolve, reject) => {
    const frameTypes: string[] = [];
    const ws = new WebSocket(`${baseUrl}/${encodeURIComponent(organizationId)}/ws/?token=${encodeURIComponent(token)}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for admin WS handshake rejection"));
    }, 1_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type) frameTypes.push(frame.type);
    });
    ws.once("error", reject);
    ws.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, frameTypes });
    });
  });
}

function completeHandshake(
  baseUrl: string,
  token: string,
  organizationId: string,
): Promise<{ kind: "admitted" } | { kind: "closed"; code: number } | { kind: "http"; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/${encodeURIComponent(organizationId)}/ws/?token=${encodeURIComponent(token)}`);
    let admitted = false;
    let settled = false;
    const finish = (
      result: { kind: "admitted" } | { kind: "closed"; code: number } | { kind: "http"; statusCode: number },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for admin WS handshake"));
    }, 5_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type !== "admin:connected") return;
      admitted = true;
      ws.close();
    });
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      finish({ kind: "http", statusCode: response.statusCode ?? 0 });
    });
    ws.once("close", (code) => {
      clearTimeout(timeout);
      finish(admitted ? { kind: "admitted" } : { kind: "closed", code });
    });
    ws.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

describe("Admin WS membership lifecycle", () => {
  const openApps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
  });

  it("rejects a suspended account before the Team socket handshake completes", async () => {
    const app = await createTestApp();
    openApps.push(app);
    const wsBaseUrl = await listenApp(app);
    const account = await createTestAdmin(app, { username: `ws-suspended-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, account.userId));

    const outcome = await observeHandshakeClose(wsBaseUrl, account.accessToken, account.organizationId);

    expect(outcome.code).toBe(4403);
    expect(outcome.frameTypes).not.toContain("admin:connected");
  });

  it("isolates valid admin WebSocket handshake limits by verified user behind one IP", async () => {
    const app = await createTestApp();
    openApps.push(app);
    const wsBaseUrl = await listenApp(app);
    const first = await createTestAdmin(app, { username: `ws-limit-first-${crypto.randomUUID().slice(0, 8)}` });
    const second = await createTestAdmin(app, { username: `ws-limit-second-${crypto.randomUUID().slice(0, 8)}` });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(completeHandshake(wsBaseUrl, first.accessToken, first.organizationId)).resolves.toEqual({
        kind: "admitted",
      });
    }
    await expect(completeHandshake(wsBaseUrl, first.accessToken, first.organizationId)).resolves.toEqual({
      kind: "http",
      statusCode: 429,
    });
    await expect(completeHandshake(wsBaseUrl, second.accessToken, second.organizationId)).resolves.toEqual({
      kind: "admitted",
    });
  });

  it("keeps repeated invalid admin WebSocket tokens capped by client IP", async () => {
    const app = await createTestApp();
    openApps.push(app);
    const wsBaseUrl = await listenApp(app);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(completeHandshake(wsBaseUrl, `invalid-${attempt}`, DEFAULT_ORG_ID)).resolves.toEqual({
        kind: "closed",
        code: 4001,
      });
    }
    await expect(completeHandshake(wsBaseUrl, "invalid-over-limit", DEFAULT_ORG_ID)).resolves.toEqual({
      kind: "http",
      statusCode: 429,
    });
  });

  it("evicts a suspended account before sending the next protected Team frame", async () => {
    const app = await createTestApp();
    openApps.push(app);
    const wsBaseUrl = await listenApp(app);
    const account = await createTestAdmin(app, { username: `ws-live-suspended-${crypto.randomUUID().slice(0, 8)}` });
    const socket = await openAdminSocket(wsBaseUrl, account.accessToken, account.organizationId);
    const observedTypes: string[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type) observedTypes.push(frame.type);
    });
    const authorizationClose = waitForMembershipClose(socket);

    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, account.userId));
    broadcastToAdmins({ type: "suspended-account-probe", organizationId: account.organizationId });

    await expect(authorizationClose).resolves.toMatchObject({ code: 4403 });
    expect(observedTypes).not.toContain("suspended-account-probe");
  });

  for (const boundary of ["repair-required", "invitation-required"] as const) {
    it(`closes an already-open socket across replicas after admin removal at the ${boundary} boundary`, async () => {
      const appOptions = boundary === "invitation-required" ? { allowedOrganizationId: DEFAULT_ORG_ID } : {};
      const mutationApp = await createTestApp(appOptions);
      openApps.push(mutationApp);
      await listenApp(mutationApp);
      // Register the socket-hosting instance last so the process-local test
      // broadcaster targets the same instance whose socket we observe. The
      // lifecycle signal itself still crosses from mutationApp through PG.
      const socketApp = await createTestApp(appOptions);
      openApps.push(socketApp);
      const socketBaseUrl = await listenApp(socketApp);

      const host = await createTestAdmin(mutationApp, { username: `ws-host-${crypto.randomUUID().slice(0, 8)}` });
      const target = await createMember(mutationApp.db, host.organizationId, {
        username: `ws-target-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Socket Removal Target",
        role: "member",
      });
      const tokens = await signTokensForUser(
        mutationApp.config.secrets.jwtSecret,
        target.userId,
        mutationApp.config.auth,
      );
      const socket = await openAdminSocket(socketBaseUrl, tokens.accessToken, host.organizationId);
      const lifecycleClose = waitForMembershipClose(socket);

      const removed = await mutationApp.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${host.organizationId}/members/${target.id}`,
        headers: { authorization: `Bearer ${host.accessToken}` },
      });

      expect(removed.statusCode).toBe(204);
      await expect(lifecycleClose).resolves.toEqual({
        code: 4403,
        frame: {
          type: "membership:changed",
          memberId: target.id,
          organizationId: host.organizationId,
        },
      });
      const activeMemberships = await mutationApp.db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.userId, target.userId), eq(members.status, "active")));
      expect(activeMemberships).toHaveLength(0);
    });
  }

  it("revalidates an open socket against live membership before an ongoing broadcast", async () => {
    const app = await createTestApp();
    openApps.push(app);
    const wsBaseUrl = await listenApp(app);
    const account = await createTestAdmin(app, { username: `ws-live-${crypto.randomUUID().slice(0, 8)}` });
    const socket = await openAdminSocket(wsBaseUrl, account.accessToken, account.organizationId);
    const observedTypes: string[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string };
      if (frame.type) observedTypes.push(frame.type);
    });
    const lifecycleClose = waitForMembershipClose(socket);

    // Simulate a missed volatile membership NOTIFY. The next broadcast must
    // still consult the live membership row before it discloses a Team frame.
    await app.db.update(members).set({ status: "removed" }).where(eq(members.id, account.memberId));
    broadcastToAdmins({ type: "live-membership-probe", organizationId: account.organizationId });

    await expect(lifecycleClose).resolves.toMatchObject({ code: 4403 });
    expect(observedTypes).not.toContain("live-membership-probe");
  });
});
