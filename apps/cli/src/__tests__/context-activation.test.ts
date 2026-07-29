import { describe, expect, it, vi } from "vitest";
import {
  activateExternalContext,
  ExternalContextActivationRequiredError,
  renderProviderSessionStartResponse,
  requireConnectedExternalContext,
} from "../core/context-integration/activation.js";

const preflight = {
  checkoutRoot: "/work/payments",
  repositoryKey: "github.com/acme/payments",
  originUrl: "git@github.com:acme/payments.git",
} as const;

describe("external Context activation", () => {
  it("uses only the exact local Team binding and returns a short connected envelope", async () => {
    const validate = vi.fn(async () => ({
      schemaVersion: 1 as const,
      outcome: "connected" as const,
      team: {
        organizationId: "org_acme",
        displayName: "Acme",
        role: "member" as const,
      },
    }));
    const result = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "codex", cwd: "/work/payments/src" },
      {
        inspect: () => preflight,
        findBinding: () => ({
          provider: "codex",
          checkoutRoot: preflight.checkoutRoot,
          repositoryKey: preflight.repositoryKey,
          organizationId: "org_acme",
        }),
      },
    );

    expect(validate).toHaveBeenCalledWith(
      "org_acme",
      {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      },
      { retry: false, timeoutMs: 2_000 },
    );
    expect(result.outcome).toBe("connected");
    expect(result.additionalContext).toContain("Team: Acme (org_acme)");
    expect(result.additionalContext).toContain("not a First Tree Chat");
    expect(JSON.stringify(renderProviderSessionStartResponse(result)).length).toBeLessThan(2_048);
  });

  it("does not infer a Team when the checkout has no explicit binding", async () => {
    const validate = vi.fn();
    const result = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "claude-code", cwd: "/work/payments" },
      { inspect: () => preflight, findBinding: () => null },
    );

    expect(result).toMatchObject({ outcome: "disabled", reasonCode: "binding_missing" });
    expect(validate).not.toHaveBeenCalled();
    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "claude-code", cwd: "/work/payments" },
        { inspect: () => preflight, findBinding: () => null },
      ),
    ).rejects.toBeInstanceOf(ExternalContextActivationRequiredError);
  });

  it("fails closed on repository drift and authority timeout without blocking coding", async () => {
    const drift = await activateExternalContext(
      { validateMemberContextActivation: vi.fn() },
      { provider: "codex", cwd: "/work/payments" },
      {
        inspect: () => preflight,
        findBinding: () => ({
          provider: "codex",
          checkoutRoot: preflight.checkoutRoot,
          repositoryKey: "github.com/acme/other",
          organizationId: "org_acme",
        }),
      },
    );
    expect(drift).toMatchObject({
      outcome: "disabled",
      reasonCode: "binding_repository_drift",
    });

    const unavailable = await activateExternalContext(
      {
        validateMemberContextActivation: async () => {
          throw new Error("timeout");
        },
      },
      { provider: "codex", cwd: "/work/payments" },
      {
        inspect: () => preflight,
        findBinding: () => ({
          provider: "codex",
          checkoutRoot: preflight.checkoutRoot,
          repositoryKey: preflight.repositoryKey,
          organizationId: "org_acme",
        }),
      },
    );
    expect(unavailable).toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_unavailable",
    });
    expect(renderProviderSessionStartResponse(unavailable)).toMatchObject({ continue: true });
  });
});
