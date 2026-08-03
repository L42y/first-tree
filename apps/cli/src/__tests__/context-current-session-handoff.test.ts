import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConnectedContextAdditionalContext } from "../core/context-integration/activation.js";
import { buildCurrentSessionHandoff } from "../core/context-integration/current-session-handoff.js";

const roots: string[] = [];
const team = { organizationId: "org-acme", displayName: "Acme", role: "member" as const };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("current-session Context handoff", () => {
  it("builds a stable catalog from the verified provider-installed payload", () => {
    const pluginRoot = createPlugin();
    const handoff = buildCurrentSessionHandoff({
      provider: "codex",
      project: { kind: "path", root: "/work/project" },
      team,
      installedPluginRoot: pluginRoot,
    });

    expect(handoff).toEqual({
      schemaVersion: 1,
      provider: "codex",
      project: { kind: "path", root: "/work/project" },
      activationContext: buildConnectedContextAdditionalContext(team),
      skills: ["first-tree", "first-tree-read", "first-tree-write"].map((name) => ({
        name,
        description: `${name} description`,
        skillPath: join(pluginRoot, "skills", name, "SKILL.md"),
      })),
    });
  });

  it("rejects missing Skill manifests", () => {
    const pluginRoot = createPlugin({ omit: "first-tree-write" });
    expect(() => build(pluginRoot)).toThrow();
  });

  it("rejects symbolic-link manifests", () => {
    const pluginRoot = createPlugin();
    const target = join(pluginRoot, "target.md");
    writeFileSync(target, skillMarkdown("first-tree-read"));
    const skillPath = join(pluginRoot, "skills", "first-tree-read", "SKILL.md");
    rmSync(skillPath);
    symlinkSync(target, skillPath);

    expect(() => build(pluginRoot)).toThrow("not a regular file");
  });

  it("rejects Skill directories that escape through a symbolic link", () => {
    const pluginRoot = createPlugin();
    const external = trackedTemp("first-tree-external-skill-");
    writeFileSync(join(external, "SKILL.md"), skillMarkdown("first-tree-write"));
    const skillRoot = join(pluginRoot, "skills", "first-tree-write");
    rmSync(skillRoot, { recursive: true });
    symlinkSync(external, skillRoot, "dir");

    expect(() => build(pluginRoot)).toThrow("not a real directory");
  });

  it("rejects a frontmatter name that differs from its directory", () => {
    const pluginRoot = createPlugin({
      markdown: { "first-tree-read": skillMarkdown("other-name") },
    });
    expect(() => build(pluginRoot)).toThrow('does not match directory "first-tree-read"');
  });

  it("rejects missing or empty descriptions", () => {
    const pluginRoot = createPlugin({
      markdown: { "first-tree": "---\nname: first-tree\ndescription: '   '\n---\n\nBody\n" },
    });
    expect(() => build(pluginRoot)).toThrow("requires a non-empty string description");
  });

  it("requires an absolute provider-installed Plugin path", () => {
    expect(() => build("relative/plugin")).toThrow("must be absolute");
  });
});

function build(pluginRoot: string) {
  return buildCurrentSessionHandoff({
    provider: "claude-code",
    project: { kind: "pathless" },
    team,
    installedPluginRoot: pluginRoot,
  });
}

function createPlugin(
  options: { omit?: string; markdown?: Partial<Record<(typeof skillNames)[number], string>> } = {},
): string {
  const root = trackedTemp("first-tree-current-session-handoff-");
  const skillsRoot = join(root, "skills");
  mkdirSync(skillsRoot);
  for (const name of skillNames) {
    if (name === options.omit) continue;
    const skillRoot = join(skillsRoot, name);
    mkdirSync(skillRoot);
    writeFileSync(join(skillRoot, "SKILL.md"), options.markdown?.[name] ?? skillMarkdown(name));
  }
  return root;
}

const skillNames = ["first-tree", "first-tree-read", "first-tree-write"] as const;

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody\n`;
}

function trackedTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
