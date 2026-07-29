import { describe, expect, it } from "vitest";
import { parseTeamSkillBundleEntryPath, TEAM_SKILL_BUNDLE_LIMITS } from "../schemas/team-skill-bundle.js";

describe("Team Skill bundle paths", () => {
  it("accepts portable paths within the shared cross-platform bounds", () => {
    expect(parseTeamSkillBundleEntryPath("references/policy.md")).toMatchObject({
      normalized: "references/policy.md",
      directory: false,
    });
    expect(parseTeamSkillBundleEntryPath(`${"a".repeat(TEAM_SKILL_BUNDLE_LIMITS.segmentCodeUnits)}/file.txt`)).not.toBe(
      null,
    );
  });

  it("rejects segments and extracted paths beyond the shared materialization bounds", () => {
    expect(
      parseTeamSkillBundleEntryPath(`${"a".repeat(TEAM_SKILL_BUNDLE_LIMITS.segmentCodeUnits + 1)}/file.txt`),
    ).toBeNull();
    expect(parseTeamSkillBundleEntryPath(`${"界".repeat(80)}.txt`)).toBeNull();

    const overlongPath = `${Array.from({ length: 8 }, () => "a".repeat(100)).join("/")}/file.txt`;
    expect(overlongPath.length).toBeGreaterThan(TEAM_SKILL_BUNDLE_LIMITS.pathCodeUnits);
    expect(parseTeamSkillBundleEntryPath(overlongPath)).toBeNull();
  });
});
