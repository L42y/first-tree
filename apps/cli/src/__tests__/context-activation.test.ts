import { readCanonicalContextTreeWriteRouting } from "@first-tree/client";
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
  it("uses only the exact local Team binding and keeps the worst-case Unicode envelope below 2048 bytes", async () => {
    const displayName = "界".repeat(200);
    const organizationId = "019dd8ff-64e9-72bb-b057-fdf60475b3eb";
    const validate = vi.fn(async () => ({
      schemaVersion: 1 as const,
      outcome: "connected" as const,
      team: {
        organizationId,
        displayName,
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
          organizationId,
        }),
      },
    );

    expect(validate).toHaveBeenCalledWith(
      organizationId,
      {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      },
      { retry: false, timeoutMs: 2_000 },
    );
    expect(result.outcome).toBe("connected");
    expect(result.additionalContext).toContain(`Team binding: ${organizationId}; role: member.`);
    expect(result.additionalContext).not.toContain(displayName);
    expect(result.additionalContext).toContain("not First Tree Chat");
    expect(result.additionalContext).toContain(readCanonicalContextTreeWriteRouting());
    expect(result.additionalContext).toContain("standing route selects the first-tree-write workflow");
    expect(result.additionalContext).not.toContain(
      "Context writes require the installed first-tree-write workflow and the same live activation guard.",
    );
    const responseJson = JSON.stringify(renderProviderSessionStartResponse(result));
    expect(Buffer.byteLength(responseJson, "utf8")).toBeLessThan(2_048);
  });

  it("does not infer a Team when the checkout has no explicit binding", async () => {
    const validate = vi.fn();
    const result = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "claude-code", cwd: "/work/payments" },
      { inspect: () => preflight, findBinding: () => null },
    );

    expect(result).toMatchObject({ outcome: "disabled", reasonCode: "binding_missing" });
    expect(result.additionalContext).toBeUndefined();
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
    expect(drift.additionalContext).toBeUndefined();

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
    expect(unavailable.additionalContext).toBeUndefined();
    expect(renderProviderSessionStartResponse(unavailable)).toMatchObject({ continue: true });

    const needsAdmin = await activateExternalContext(
      {
        validateMemberContextActivation: async () => ({
          schemaVersion: 1,
          outcome: "needs_admin",
          team: {
            organizationId: "org_acme",
            displayName: "Acme",
            role: "member",
          },
          reasonCode: "context_tree_unbound",
          nextAction: {
            message: "Ask a Team Admin to bind a Context Tree.",
            settingsUrl: "https://app.first-tree.ai/settings/setup",
          },
        }),
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
    expect(needsAdmin.outcome).toBe("needs_admin");
    expect(needsAdmin.additionalContext).toBeUndefined();
  });
});
