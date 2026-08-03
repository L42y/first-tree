import { describe, expect, it } from "vitest";
import { contextEnablementExecutable } from "../api/orgs/context-enablement.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Context enablement handoff", () => {
  const getApp = useTestApp({ channel: "staging" });

  it("uses the channel bin for dev and the shared portable executable for published channels", () => {
    expect(contextEnablementExecutable({ channel: "dev", binName: "first-tree-dev" })).toBe("'first-tree-dev'");
    expect(contextEnablementExecutable({ channel: "staging", binName: "first-tree-staging" })).toBe(
      "~/.local/bin/first-tree-staging",
    );
    expect(contextEnablementExecutable({ channel: "prod", binName: "first-tree" })).toBe("~/.local/bin/first-tree");
  });

  it("authors an exact Team, provider, and channel command for active members", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-enablement/handoff?provider=codex`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      organizationId: admin.organizationId,
      provider: "codex",
      intent: "settings",
      role: "admin",
    });
    expect(response.json().command).toBe(
      `~/.local/bin/first-tree-staging --json context enable --provider 'codex' --team '${admin.organizationId}' --yes`,
    );
    expect(response.json().workingDirectoryInstruction).toContain("CLI centrally classifies");
    expect(response.json().workingDirectoryInstruction).not.toContain("shell cwd");
    expect(response.body).not.toContain("--no-start");
  });

  it("pre-accepts the local plan without completing onboarding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-enablement/handoff?provider=claude-code&intent=onboarding`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      organizationId: admin.organizationId,
      provider: "claude-code",
      intent: "onboarding",
    });
    expect(response.json().command).toBe(
      `~/.local/bin/first-tree-staging --json context enable --provider 'claude-code' --team '${admin.organizationId}' --yes`,
    );
    expect(response.json().workingDirectoryInstruction).toContain("host-confirmed Claude Code selector");
    expect(response.json().workingDirectoryInstruction).toContain("--pathless");
    expect(response.body).not.toContain("--complete-onboarding");
  });
});
