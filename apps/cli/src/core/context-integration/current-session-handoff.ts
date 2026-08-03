import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  parseStrictTeamSkillMarkdown,
} from "@first-tree/shared";
import { buildConnectedContextAdditionalContext } from "./activation.js";

const CURRENT_SESSION_SKILL_NAMES = ["first-tree", "first-tree-read", "first-tree-write"] as const;

export type CurrentSessionSkill = {
  name: string;
  description: string;
  skillPath: string;
};

export type CurrentSessionHandoff = {
  schemaVersion: 1;
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  activationContext: string;
  skills: CurrentSessionSkill[];
};

type ConnectedTeam = Parameters<typeof buildConnectedContextAdditionalContext>[0];

/**
 * Builds the one-shot catalog used by the coding agent that installed the
 * Plugin. The provider-owned payload has already passed the complete release
 * digest check; this boundary additionally proves that every catalog entry is
 * a real, contained Skill with strict discovery metadata.
 */
export function buildCurrentSessionHandoff(input: {
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  team: ConnectedTeam;
  installedPluginRoot: string;
}): CurrentSessionHandoff {
  const pluginRoot = assertPluginRoot(input.installedPluginRoot);
  const skillsRoot = assertDirectory(join(pluginRoot, "skills"), "Context Plugin skills directory");
  const skills = CURRENT_SESSION_SKILL_NAMES.map((expectedName) => {
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
    schemaVersion: 1,
    provider: input.provider,
    project: input.project,
    activationContext: buildConnectedContextAdditionalContext(input.team),
    skills,
  };
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
