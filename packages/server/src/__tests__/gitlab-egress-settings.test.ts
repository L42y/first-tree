import { describe, expect, it } from "vitest";
import * as contextTreeSettingsService from "../services/context-tree/settings.js";
import { createGitlabConnection } from "../services/scm/gitlab/connections.js";
import * as organizationSettingsService from "../services/settings/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("GitLab egress authorization boundaries on Settings writes", () => {
  const getApp = useTestApp({
    gitlabEgressAllowlist: [
      {
        origin: "https://gitlab.authorized:8443",
        addressPolicy: { kind: "cidrs", cidrs: ["10.20.0.0/16"] },
      },
    ],
  });

  it("creates inbound connections independently from Web Context egress authorization", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const insecureOrigin = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Insecure", instanceOrigin: "http://gitlab.authorized" },
    });
    expect(insecureOrigin.statusCode).toBe(400);

    const malformedOrigin = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Invalid", instanceOrigin: "https://gitlab.authorized/path" },
    });
    expect(malformedOrigin.statusCode).toBe(400);

    const wrongPort = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Wrong port", instanceOrigin: "https://gitlab.authorized" },
    });
    expect(wrongPort.statusCode).toBe(201);
    const created = wrongPort.json() as { connection: { id: string } };

    const insecureReplacement = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/replace`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Insecure replacement", instanceOrigin: "http://gitlab.authorized" },
    });
    expect(insecureReplacement.statusCode).toBe(400);
  });

  it("rejects a new binding when its current connection authority is absent or mismatched", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      organizationSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        {
          provider: "gitlab",
          repo: "https://gitlab.authorized:8443/acme/context.git",
          branch: "main",
        },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow(/requires a current GitLab connection/u);

    await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Different origin",
      instanceOrigin: "https://gitlab.other",
    });
    await expect(
      organizationSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        {
          provider: "gitlab",
          repo: "https://gitlab.authorized:8443/acme/context.git",
          branch: "main",
        },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow(/must match the current GitLab connection origin/u);
  });

  it("preserves and updates a binding when Web Context egress authorization is removed", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Authorized GitLab",
      instanceOrigin: "https://gitlab.authorized:8443",
    });
    await organizationSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "gitlab",
        repo: "https://gitlab.authorized:8443/acme/context.git",
        branch: "main",
      },
      { updatedBy: admin.userId },
    );

    await expect(
      organizationSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        { branch: "trunk" },
        { updatedBy: admin.userId },
      ),
    ).resolves.toMatchObject({ branch: "trunk", provider: "gitlab" });
    await expect(
      contextTreeSettingsService.getOrgContextTreeBinding(app.db, admin.organizationId),
    ).resolves.toMatchObject({
      branch: "trunk",
      provider: "gitlab",
    });
  });
});
