import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("org-scoped member Context activation", () => {
  const getApp = useTestApp();

  it.each([
    [{ schemaVersion: 2 }, 2],
    [{ schemaVersion: 1, repositoryKey: "github.com/acme/unregistered-source" }, 1],
  ] as const)("validates Team membership and Tree readiness for contract %#", async (body, schemaVersion) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/context-activation/validate`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: body,
      });

    const unbound = await request();
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({
      schemaVersion,
      outcome: "needs_admin",
      reasonCode: "context_tree_unbound",
      team: { organizationId: admin.organizationId, role: "admin" },
      nextAction: { settingsUrl: "/settings/context#binding" },
    });

    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );

    const connected = await request();
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      schemaVersion,
      outcome: "connected",
      team: { organizationId: admin.organizationId, role: "admin" },
    });

    await app.db.update(members).set({ status: "left" }).where(eq(members.id, admin.memberId));
    expect((await request()).statusCode).toBe(403);
  });

  it("takes Team only from the encoded org path and removes the old /me route", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const foreign = await createOrganization(app.db, {
      name: `foreign-${crypto.randomUUID()}`,
      displayName: "Foreign Team",
    });
    const payload = { schemaVersion: 2 };

    const nonMember = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(foreign.id)}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    expect(nonMember.statusCode).toBe(403);

    const bodyOverride = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...payload, organizationId: foreign.id },
    });
    expect(bodyOverride.statusCode).toBe(400);

    const oldRoute = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    expect(oldRoute.statusCode).toBe(404);
  });

  it("keeps v1 repositoryKey canonicalization at the compatibility boundary", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        schemaVersion: 1,
        repositoryKey: "https://token@github.com/acme/repo.git",
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
