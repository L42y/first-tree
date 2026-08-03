import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ContextActivationScope,
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  parseStrictTeamSkillMarkdown,
} from "@first-tree/shared";
import { buildByoContextAdditionalContext } from "./activation.js";

const PERSISTENT_SKILL_NAMES = ["first-tree", "first-tree-read", "first-tree-write"] as const;
const SESSION_SKILL_NAMES = ["first-tree-read", "first-tree-write"] as const;

export type CurrentSessionSkill = {
  name: string;
  description: string;
  skillPath: string;
};

export type CurrentSessionHandoff = {
  schemaVersion: 2;
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  consumerKind: "byo";
  activationScope: ContextActivationScope;
  sessionCandidate: { receipt: string } | null;
  activationContext: string;
  skills: CurrentSessionSkill[];
};

/**
 * Builds the one-shot catalog used by the coding agent that installed the
 * Plugin. The provider-owned payload has already passed the complete release
 * digest check; this boundary additionally proves that every catalog entry is
 * a real, contained Skill with strict discovery metadata.
 */
export function buildCurrentSessionHandoff(input: {
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  activationScope: ContextActivationScope;
  organizationId: string;
  sessionCandidateReceipt?: string;
  pluginRoot: string;
}): CurrentSessionHandoff {
  const pluginRoot = assertPluginRoot(input.pluginRoot);
  const skillsRoot = assertDirectory(join(pluginRoot, "skills"), "Context Plugin skills directory");
  const expectedSkills = input.activationScope.kind === "session" ? SESSION_SKILL_NAMES : PERSISTENT_SKILL_NAMES;
  const skills = expectedSkills.map((expectedName) => {
    const skillRoot = assertDirectory(join(skillsRoot, expectedName), `Context Skill ${expectedName} directory`);
    const skillPath = resolve(skillRoot, "SKILL.md");
    assertContained(pluginRoot, skillPath);
    const skill = lstatSync(skillPath);
    if (skill.isSymbolicLink() || !skill.isFile()) {
      throw new Error(`Context Skill ${expectedName} manifest is not a regular file: ${skillPath}`);
    }
    assertContained(realpathSync(pluginRoot), realpathSync(skillPath));

    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(skillPath));
    } catch (error) {
      throw new Error(`Context Skill ${expectedName} manifest is not valid UTF-8: ${message(error)}`);
    }
    const frontmatter = parseStrictTeamSkillMarkdown(markdown).frontmatter;
    if (typeof frontmatter.name !== "string" || frontmatter.name.length === 0) {
      throw new Error(`Context Skill ${expectedName} requires a non-empty string name.`);
    }
    if (frontmatter.name !== expectedName) {
      throw new Error(`Context Skill name "${frontmatter.name}" does not match directory "${expectedName}".`);
    }
    if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
      throw new Error(`Context Skill ${expectedName} requires a non-empty string description.`);
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      skillPath,
    };
  });

  return {
    schemaVersion: 2,
    provider: input.provider,
    project: input.project,
    consumerKind: "byo",
    activationScope: input.activationScope,
    sessionCandidate:
      input.activationScope.kind === "session"
        ? { receipt: requireSessionCandidateReceipt(input.sessionCandidateReceipt) }
        : null,
    activationContext: buildByoContextAdditionalContext(),
    skills,
  };
}

function requireSessionCandidateReceipt(value: string | undefined): string {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,3}$/u.test(value)) {
    throw new Error("Session-only Context handoff requires an opaque session candidate receipt.");
  }
  return value;
}

function assertPluginRoot(input: string): string {
  if (!isAbsolute(input)) {
    throw new Error(`Provider-installed Context Plugin path must be absolute: ${input}`);
  }
  return assertDirectory(resolve(input), "Provider-installed Context Plugin root");
}

function assertDirectory(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${path}`);
  }
  return path;
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) return;
  throw new Error(`Context Skill path escapes the provider-installed Plugin root: ${candidate}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
