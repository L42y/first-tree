import { describe, expect, it } from "vitest";
import {
  foldPortableTeamSkillPath,
  getPortableTeamSkillRelativePathError,
  getPortableTeamSkillSegmentError,
  normalizeTeamSkillTargetSlug,
  parseStrictTeamSkillMarkdown,
  skillDescriptorSchema,
  TEAM_SKILL_BUNDLE_LIMITS,
} from "../schemas/skill.js";

describe("skillDescriptorSchema", () => {
  const baseValid = { name: "review", description: "Pre-landing PR review", source: "user" as const };

  it("accepts a well-formed descriptor", () => {
    expect(skillDescriptorSchema.parse(baseValid)).toEqual(baseValid);
  });

  it("accepts a namespaced descriptor", () => {
    const out = skillDescriptorSchema.parse({ ...baseValid, namespace: "hyperframes", name: "gsap" });
    expect(out.namespace).toBe("hyperframes");
  });

  // Charset guard: schema MUST agree with `detectSlashTrigger`'s accept-set
  // in the web composer (`[A-Za-z0-9_-]`). A schema-passing skill whose
  // name contains spaces or `/` would be unreachable from the popover —
  // the user would type the bad char and the trigger would close
  // mid-query. Rejecting at schema is the only way to keep the contract
  // single-source.
  it("rejects a name containing whitespace", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "weird name" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects a name containing `/`", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "foo/bar" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects a name starting with `-` or `_`", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "-foo" })).toThrow(/A-Za-z0-9_-/);
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "_foo" })).toThrow(/A-Za-z0-9_-/);
  });

  it("applies the same charset to namespace", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, namespace: "bad ns" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects an empty name", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "" })).toThrow();
  });
});

describe("portable Team Skill contract", () => {
  it("normalizes provider target slugs and rejects reserved or oversized results", () => {
    expect(normalizeTeamSkillTargetSlug("Review_Check")).toBe("review-check");
    for (const name of ["first_tree_read", "first-tree-read-", "CON", "a".repeat(64)]) {
      expect(() => normalizeTeamSkillTargetSlug(name)).toThrow();
    }
  });

  it("folds Unicode-equivalent paths before collision checks", () => {
    expect(foldPortableTeamSkillPath("references/Café.md")).toBe(foldPortableTeamSkillPath("references/Cafe\u0301.md"));
  });

  it("rejects non-portable and overlong path components", () => {
    for (const segment of [
      "CON",
      "COM¹.txt",
      "LPT³",
      "trailing.",
      "trailing ",
      "bad:name",
      "a".repeat(241),
      "e\u0301".repeat(100),
    ]) {
      expect(getPortableTeamSkillSegmentError(segment)).not.toBeNull();
    }
    expect(getPortableTeamSkillSegmentError("guide.md")).toBeNull();
  });

  it("bounds normalized relative path depth and length", () => {
    const tooDeep = `${Array.from({ length: TEAM_SKILL_BUNDLE_LIMITS.maxDepth + 1 }, () => "d").join("/")}/x`;
    const deepestEmptyDirectory = Array.from({ length: TEAM_SKILL_BUNDLE_LIMITS.maxDepth + 1 }, () => "d").join("/");
    const tooLong = `${Array.from({ length: 4 }, () => "a".repeat(200)).join("/")}/x`;
    const rawTooLong = Array.from({ length: 4 }, () => "e\u0301".repeat(80)).join("/");
    expect(getPortableTeamSkillRelativePathError(tooDeep)).toContain("depth");
    expect(getPortableTeamSkillRelativePathError(tooLong)).toContain("length");
    expect(getPortableTeamSkillRelativePathError(rawTooLong)).toContain("length");
    expect(getPortableTeamSkillRelativePathError(deepestEmptyDirectory, "directory")).toContain("depth");
    expect(getPortableTeamSkillRelativePathError("references/guide.md")).toBeNull();
  });

  it("uses one strict manifest envelope without trimming the declared name", () => {
    expect(parseStrictTeamSkillMarkdown("---\nname: review\ndescription: Review\n---\n\nBody")).toMatchObject({
      frontmatter: { name: "review", description: "Review" },
      body: "\nBody",
    });
    expect(() => parseStrictTeamSkillMarkdown("---\nname: review\ndescription: Review\n---junk\nBody")).toThrow(
      "YAML frontmatter",
    );
    expect(parseStrictTeamSkillMarkdown('---\nname: " review "\ndescription: Review\n---\n').frontmatter.name).toBe(
      " review ",
    );
  });

  it("rejects YAML aliases and non-finite metadata before JSON persistence", () => {
    expect(() =>
      parseStrictTeamSkillMarkdown(
        "---\nname: review\ndescription: Review\nmetadata: &self\n  nested: *self\n---\nBody",
      ),
    ).toThrow(/alias|resource exhaustion/i);
    expect(() =>
      parseStrictTeamSkillMarkdown("---\nname: review\ndescription: Review\nmetadata:\n  score: .inf\n---\nBody"),
    ).toThrow(/finite/i);
  });
});
