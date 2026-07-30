import { describe, expect, it } from "vitest";
import {
  contextIntegrationConfigSchema,
  contextIntegrationInstallJournalSchema,
  contextIntegrationInstallManifestSchema,
  contextIntegrationReleaseManifestSchema,
  legacyContextIntegrationConfigSchema,
} from "../index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("context integration contracts", () => {
  it("parses provider path and pathless project bindings", () => {
    const parsed = contextIntegrationConfigSchema.parse({
      schemaVersion: 2,
      bindings: [
        {
          provider: "codex",
          project: { kind: "path", root: "/work/payments" },
          organizationId: "org_acme",
        },
        {
          provider: "claude-code",
          project: { kind: "pathless" },
          organizationId: "org_acme",
        },
      ],
    });
    expect(parsed.bindings).toHaveLength(2);
  });

  it("rejects unsupported providers", () => {
    expect(
      contextIntegrationConfigSchema.safeParse({
        schemaVersion: 2,
        bindings: [
          {
            provider: "remote",
            project: { kind: "path", root: "/work/payments" },
            organizationId: "org_acme",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "pathless",
      [
        { provider: "codex", project: { kind: "pathless" }, organizationId: "org_a" },
        { provider: "codex", project: { kind: "pathless" }, organizationId: "org_b" },
      ],
    ],
    [
      "path",
      [
        { provider: "codex", project: { kind: "path", root: "/work/project" }, organizationId: "org_a" },
        { provider: "codex", project: { kind: "path", root: "/work/project" }, organizationId: "org_b" },
      ],
    ],
  ])("rejects duplicate provider + %s project identities", (_kind, bindings) => {
    expect(contextIntegrationConfigSchema.safeParse({ schemaVersion: 2, bindings }).success).toBe(false);
  });

  it("allows overlapping ancestor projects because their identities are distinct", () => {
    expect(
      contextIntegrationConfigSchema.safeParse({
        schemaVersion: 2,
        bindings: [
          { provider: "codex", project: { kind: "path", root: "/work" }, organizationId: "org_a" },
          { provider: "codex", project: { kind: "path", root: "/work/project" }, organizationId: "org_b" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a legacy migration with duplicate provider + checkout identities", () => {
    expect(
      legacyContextIntegrationConfigSchema.safeParse({
        schemaVersion: 1,
        bindings: [
          {
            provider: "codex",
            checkoutRoot: "/work/project",
            repositoryKey: "github.com/acme/one",
            organizationId: "org_a",
          },
          {
            provider: "codex",
            checkoutRoot: "/work/project",
            repositoryKey: "github.com/acme/two",
            organizationId: "org_b",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires policy digests in installed and release manifests", () => {
    expect(
      contextIntegrationInstallManifestSchema.parse({
        schemaVersion: 1,
        channel: "prod",
        provider: "codex",
        firstTreeVersion: "1.0.0",
        bundleVersion: "1.0.0",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        adapterDigest: DIGEST,
        marketplaceName: "first-tree",
        pluginName: "first-tree-context",
        materializedInvocation: "/opt/first-tree/bin/first-tree",
        installedAt: "2026-07-28T00:00:00.000Z",
      }).policyDigest,
    ).toBe(DIGEST);

    expect(
      contextIntegrationInstallManifestSchema.safeParse({
        schemaVersion: 1,
        channel: "prod",
        provider: "codex",
        firstTreeVersion: "1.0.0",
        bundleVersion: "1.0.0",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        adapterDigest: DIGEST,
        marketplaceName: "first-tree",
        pluginName: "first-tree-context",
        materializedInvocation: "",
        installedAt: "2026-07-28T00:00:00.000Z",
      }).success,
    ).toBe(false);

    expect(
      contextIntegrationReleaseManifestSchema.parse({
        schemaVersion: 1,
        version: "1.0.0",
        channel: "prod",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        providers: {
          codex: { adapterDigest: DIGEST, minimumVersion: "1.0.0" },
          "claude-code": { adapterDigest: DIGEST, minimumVersion: "1.0.0" },
        },
      }).policyDigest,
    ).toBe(DIGEST);
  });

  it("validates recoverable install journal phases without local paths", () => {
    expect(
      contextIntegrationInstallJournalSchema.parse({
        schemaVersion: 1,
        provider: "claude-code",
        operation: "repair",
        previousBundleDigest: DIGEST,
        targetBundleDigest: DIGEST,
        startedAt: "2026-07-28T00:00:00.000Z",
        phase: "provider_installing",
      }).phase,
    ).toBe("provider_installing");
  });
});
