import type { ConfirmTeamRepositories } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Admin Team repository confirmation", () => {
  const getApp = useTestApp();

  it("atomically confirms, canonically deduplicates, reruns idempotently, and never retires omissions", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const request = (payload: ConfirmTeamRepositories) =>
      app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/resources/repositories/confirm`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload,
      });

    const duplicate = await request({
      expectedActiveRepositoryKeys: [],
      repositories: [
        { name: "App", url: "https://github.com/Acme/App.git" },
        { name: "Same app", url: "git@github.com:acme/app.git" },
      ],
    });
    expect(duplicate.statusCode).toBe(400);

    const created = await request({
      expectedActiveRepositoryKeys: [],
      repositories: [
        { name: "App", url: "https://github.com/acme/app.git" },
        { name: "API", url: "https://github.com/acme/api.git", defaultBranch: "trunk" },
      ],
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().repositories).toHaveLength(2);

    const rerun = await request({
      expectedActiveRepositoryKeys: ["github.com/acme/api", "github.com/acme/app"],
      repositories: [{ name: "App renamed", url: "git@github.com:acme/app.git" }],
    });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().repositories).toMatchObject([
      { name: "App renamed", repoCanonicalKey: "github.com/acme/app", status: "active" },
    ]);

    const listed = await app.resourcesService.listTeamResources(admin.organizationId);
    expect(listed.filter((row) => row.type === "repo" && row.status === "active")).toHaveLength(2);
    expect(listed.find((row) => row.repoCanonicalKey === "github.com/acme/api")?.status).toBe("active");
  });

  it("returns 409 for a stale observed set and 403 for an ordinary member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await app.resourcesService.createTeamResource(
      admin.organizationId,
      {
        type: "repo",
        name: "Concurrent",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/acme/concurrent.git" },
      },
      admin.memberId,
    );

    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/resources/repositories/confirm`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          expectedActiveRepositoryKeys: [],
          repositories: [{ name: "App", url: "https://github.com/acme/app.git" }],
        },
      });
    expect((await request()).statusCode).toBe(409);

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
    expect((await request()).statusCode).toBe(403);
  });
});
