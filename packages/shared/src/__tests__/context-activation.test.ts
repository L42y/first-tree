import { describe, expect, it } from "vitest";
import {
  canonicalResourceRepoKeySchema,
  contextActivationRequestSchema,
  contextActivationResponseSchema,
} from "../index.js";

describe("context activation contracts", () => {
  it.each([
    "github.com/acme/payments",
    "gitlab.example.com/Group/Payments",
    "git.example.com:2222/Team/Repo",
  ])("accepts canonical repository key %s", (repositoryKey) => {
    expect(canonicalResourceRepoKeySchema.parse(repositoryKey)).toBe(repositoryKey);
  });

  it.each([
    "https://github.com/acme/payments.git",
    "git@github.com:acme/payments.git",
    "user@github.com/acme/payments",
    "github.com/acme/payments.git",
    "github.com/ACME/PAYMENTS",
    "github.com/acme/payments\nother",
  ])("rejects non-canonical or unsafe repository key %s", (repositoryKey) => {
    expect(canonicalResourceRepoKeySchema.safeParse(repositoryKey).success).toBe(false);
  });

  it("accepts the repo-independent v2 body and temporary legacy v1 body", () => {
    expect(contextActivationRequestSchema.parse({ schemaVersion: 2 })).toEqual({ schemaVersion: 2 });
    expect(
      contextActivationRequestSchema.parse({
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      }),
    ).toEqual({
      schemaVersion: 1,
      repositoryKey: "github.com/acme/payments",
    });
    expect(
      contextActivationRequestSchema.safeParse({
        schemaVersion: 2,
        repositoryKey: "github.com/acme/payments",
      }).success,
    ).toBe(false);
    expect(
      contextActivationRequestSchema.safeParse({
        schemaVersion: 1,
        organizationId: "org_other",
        repositoryKey: "github.com/acme/payments",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown outcomes", () => {
    expect(
      contextActivationResponseSchema.safeParse({
        schemaVersion: 1,
        outcome: "matched_multiple",
        team: { organizationId: "org_acme", displayName: "Acme" },
      }).success,
    ).toBe(false);
  });
});
