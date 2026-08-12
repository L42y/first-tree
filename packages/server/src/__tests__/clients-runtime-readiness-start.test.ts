import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import { capabilitiesForApi } from "../services/runtime/client.js";
import { removeClientConnection, setClientConnection } from "../services/runtime/connection-manager.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("POST /clients/:clientId/runtime-readiness/start", () => {
  const getApp = useTestApp();

  it("forwards one typed readiness command to the connected daemon", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `rr-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(clients)
      .set({ status: "connected", instanceId: app.config.instanceId, sdkVersion: "0.5.21" })
      .where(eq(clients.id, admin.clientId));
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-readiness/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "codex", config: { model: "gpt-test", configIdentity: "b".repeat(64) }, force: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ started: true });
      expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toEqual({
        type: "runtime-readiness:check",
        provider: "codex",
        config: { model: "gpt-test", configIdentity: "b".repeat(64) },
        force: true,
        ref: body.ref,
      });
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("fans the command to the DB-authoritative remote instance", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `rr-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(clients)
      .set({ status: "connected", instanceId: "replica-other", sdkVersion: "0.5.21" })
      .where(eq(clients.id, admin.clientId));
    const notify = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${admin.clientId}/runtime-readiness/start`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { provider: "claude-code" },
    });

    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime-readiness:check",
        clientId: admin.clientId,
        provider: "claude-code",
        targetInstanceId: "replica-other",
      }),
    );
    notify.mockRestore();
  });

  it("fails closed before delivery when the connected daemon predates readiness commands", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `rr-old-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(clients)
      .set({ status: "connected", instanceId: app.config.instanceId, sdkVersion: "0.5.20" })
      .where(eq(clients.id, admin.clientId));
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-readiness/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "codex" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("First Tree CLI 0.5.21 or newer"),
      });
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("returns 503 without a live DB-authoritative computer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `rr-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(clients)
      .set({ status: "disconnected", instanceId: null })
      .where(eq(clients.id, admin.clientId));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${admin.clientId}/runtime-readiness/start`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { provider: "codex" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("rejects malformed providers and cross-user access", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `rr-o-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `rr-x-${crypto.randomUUID().slice(0, 6)}` });
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${owner.clientId}/runtime-readiness/start`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { provider: "unknown" },
    });
    expect(invalid.statusCode).toBe(400);
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${owner.clientId}/runtime-readiness/start`,
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { provider: "codex" },
    });
    expect(forbidden.statusCode).toBeGreaterThanOrEqual(400);
    expect(forbidden.statusCode).toBeLessThan(500);
  });
});

describe("runtime readiness API projection", () => {
  const detectedAt = "2026-08-12T08:00:00.000Z";
  const base = { state: "ok" as const, available: true, detectedAt };

  it("projects installed-only, expired, login, and offline states without mutating metadata", () => {
    const metadata = {
      capabilities: {
        codex: base,
        "claude-code": {
          ...base,
          readiness: {
            state: "ready" as const,
            checkedAt: detectedAt,
            expiresAt: "2026-08-12T08:05:00.000Z",
          },
        },
        cursor: {
          ...base,
          lastAuthError: { reason: "exit-nonzero" as const, at: detectedAt },
        },
      },
    };

    const online = capabilitiesForApi(metadata, { status: "connected" }, Date.parse("2026-08-12T08:10:00.000Z"));
    expect(online.codex?.readiness?.state).toBe("available");
    expect(online["claude-code"]?.readiness?.state).toBe("expired");
    expect(online.cursor?.readiness?.state).toBe("needs_login");

    const offline = capabilitiesForApi(metadata, { status: "disconnected" });
    expect(Object.values(offline).every((entry) => entry.readiness?.state === "computer_offline")).toBe(true);
    expect(metadata.capabilities.codex).not.toHaveProperty("readiness");
  });
});
