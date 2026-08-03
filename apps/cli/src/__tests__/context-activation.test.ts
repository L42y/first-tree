import { describe, expect, it, vi } from "vitest";
import {
  activateExternalContext,
  buildByoContextAdditionalContext,
  requireConnectedExternalContext,
} from "../core/context-integration/activation.js";

const project = { kind: "path" as const, root: "/work/app" };
const grant = { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };

describe("neutral multi-Team activation", () => {
  it("SessionStart injects a neutral router and does not validate or choose a Team", async () => {
    const validator = { validateMemberContextActivation: vi.fn() };
    const result = await activateExternalContext(
      validator,
      { provider: "codex", project },
      {
        resolveCandidates: () => [
          { grant, priority: "global" },
          { grant: { ...grant, organizationId: "org-b" }, priority: "global" },
        ],
      },
    );
    expect(result).toMatchObject({ outcome: "connected", candidateCount: 2 });
    expect(result.additionalContext).toContain("consumerKind: byo");
    expect(result.additionalContext).not.toContain("org-a");
    expect(validator.validateMemberContextActivation).not.toHaveBeenCalled();
  });

  it("fails closed without a local grant", async () => {
    await expect(
      activateExternalContext(
        { validateMemberContextActivation: vi.fn() },
        { provider: "codex", project },
        { resolveCandidates: () => [] },
      ),
    ).resolves.toMatchObject({ outcome: "disabled", reasonCode: "grant_missing" });
  });

  it("legacy direct guard refuses ambiguity and validates the sole local candidate", async () => {
    const validator = {
      validateMemberContextActivation: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        outcome: "connected",
        team: { organizationId: "org-a", displayName: "A", role: "admin" },
      }),
    };
    await expect(
      requireConnectedExternalContext(
        validator,
        { provider: "codex", project },
        { resolveCandidates: () => [{ grant, priority: "global" }] },
      ),
    ).resolves.toMatchObject({ team: { organizationId: "org-a" }, grant });
    await expect(
      requireConnectedExternalContext(
        validator,
        { provider: "codex", project },
        {
          resolveCandidates: () => [
            { grant, priority: "global" },
            { grant: { ...grant, organizationId: "org-b" }, priority: "global" },
          ],
        },
      ),
    ).rejects.toMatchObject({ reasonCode: "route_required" });
  });

  it("standing context mandates SCOPE routing and BYO write confirmation", () => {
    const context = buildByoContextAdditionalContext();
    expect(context).toContain("SCOPE.md");
    expect(context).toContain("wait for a new user confirmation");
  });
});
