import { describe, expect, it } from "vitest";
import { buildExternalContextReadResult } from "../commands/context/read.js";
import { buildConnectedContextAdditionalContext } from "../core/context-integration/activation.js";

describe("external Context read activation receipt", () => {
  it.each([
    ["codex", { kind: "pathless" }, ["--pathless"]],
    ["claude-code", { kind: "path", root: "/work/project" }, ["--project-root", "/work/project"]],
  ] as const)("returns the resolver-owned %s project identity for later write reuse", (provider, project, selectorArgs) => {
    const team = {
      organizationId: "org_acme",
      displayName: "Acme",
      role: "member" as const,
    };
    const activationContext = buildConnectedContextAdditionalContext(team);
    expect(
      buildExternalContextReadResult(
        {
          teamId: "org_acme",
          snapshotPath: "/tmp/context-tree",
          commit: "a".repeat(40),
        },
        provider,
        project,
        activationContext,
      ),
    ).toMatchObject({
      activationProject: { provider, project, selectorArgs },
      activationContext,
      snapshotPath: "/tmp/context-tree",
    });
  });
});
