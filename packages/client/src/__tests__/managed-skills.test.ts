import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeProvider, RuntimeResourceSkill } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import {
  authoritativeTeamSkillSnapshot,
  type ManagedSkillsCheckpoint,
  providerSkillRoot,
  reconcileManagedSkills,
} from "../runtime/managed-skills.js";
import {
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_SKILLS_LOCK_REL,
  MANAGED_STATE_REL,
  readManagedState,
  readManagedStateResult,
} from "../runtime/managed-state.js";

const PROVIDERS: readonly RuntimeProvider[] = ["claude-code", "claude-code-tui", "codex", "cursor", "kimi-code"];

function teamSkill(overrides: Partial<RuntimeResourceSkill> = {}): RuntimeResourceSkill {
  return {
    resourceId: "resource-review",
    name: "Review",
    description: "Review correctness before style.",
    body: "# Review\n\nCheck correctness first.",
    metadata: { owner: "platform" },
    ...overrides,
  };
}

function writeCoreBundle(parent: string, version = "1.0.0", label = version): string {
  const root = join(parent, `bundled-${label.replace(/[^a-z0-9-]/giu, "-")}`);
  for (const name of CORE_SKILL_NAMES) {
    const skillRoot = join(root, name);
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Fixture ${label} for ${name}.`, "---", "", `# ${name}`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), `${version}\n`);
    writeFileSync(join(skillRoot, "references", "guide.md"), `supporting ${label} for ${name}\n`);
  }
  return root;
}

function target(workspace: string, provider: RuntimeProvider, name: string): string {
  return join(workspace, providerSkillRoot(provider), name);
}

function writeLegacyState(workspace: string, skills: readonly string[]): void {
  mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, MANAGED_STATE_REL),
    JSON.stringify({
      schemaVersion: 1,
      cliVersion: "0.1.0",
      updatedAt: new Date(0).toISOString(),
      skills,
    }),
  );
}

describe("managed Skill reconciler", () => {
  let sandbox: string;
  let workspace: string;
  let bundledSkillsRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "ft-managed-skills-"));
    workspace = join(sandbox, "workspace");
    mkdirSync(workspace, { recursive: true });
    bundledSkillsRoot = writeCoreBundle(sandbox);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("maps every runtime to its provider-native discovery root", () => {
    expect(PROVIDERS.map((provider) => [provider, providerSkillRoot(provider)])).toEqual([
      ["claude-code", ".claude/skills"],
      ["claude-code-tui", ".claude/skills"],
      ["codex", ".agents/skills"],
      ["cursor", ".cursor/skills"],
      ["kimi-code", ".kimi-code/skills"],
    ]);
  });

  it.each(PROVIDERS)("projects Core Skills only into the active %s discovery root", async (provider) => {
    const result = await reconcileManagedSkills({
      workspace,
      provider,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.installed).toHaveLength(CORE_SKILL_NAMES.length);
    for (const name of CORE_SKILL_NAMES) {
      const installedRoot = target(workspace, provider, name);
      expect(readFileSync(join(installedRoot, "VERSION"), "utf-8")).toBe("1.0.0\n");
      expect(readFileSync(join(installedRoot, "references", "guide.md"), "utf-8")).toContain(
        `supporting 1.0.0 for ${name}`,
      );
      expect(JSON.parse(readFileSync(join(installedRoot, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
        schemaVersion: 1,
        key: `core:${name}`,
        revision: "1.0.0",
      });
    }

    for (const otherProvider of PROVIDERS) {
      if (providerSkillRoot(otherProvider) === providerSkillRoot(provider)) continue;
      expect(existsSync(target(workspace, otherProvider, CORE_SKILL_NAMES[0]))).toBe(false);
    }
  });

  it("hashes the final tree and repairs supporting-file drift even when VERSION is unchanged", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const drifted = target(workspace, "codex", "first-tree-read");
    writeFileSync(join(drifted, "references", "guide.md"), "user drift\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.installed).toContain("core:first-tree-read");
    expect(readFileSync(join(drifted, "references", "guide.md"), "utf-8")).toContain(
      "supporting 1.0.0 for first-tree-read",
    );
    expect(result.skipped).toContain("core:first-tree-write");
  });

  it("installs, updates, preserves, and revokes Team Skills only from authoritative snapshots", async () => {
    const v10 = teamSkill();
    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(10, [v10]),
      bundledSkillsRoot,
    });
    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);
    expect(installed.teamSkills).toMatchObject([
      {
        key: "resource:resource-review",
        name: "review",
        description: "Review correctness before style.",
        target: ".agents/skills/review",
      },
    ]);
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toContain(
      "Check correctness first.",
    );

    const unavailable = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: { kind: "unavailable" },
      bundledSkillsRoot,
    });
    expect(unavailable.ok).toBe(true);
    expect(unavailable.teamSkills).toEqual([]);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);

    const stale = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(9, []),
      bundledSkillsRoot,
    });
    expect(stale.staleTeamSnapshot).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(10);

    const updated = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(11, [teamSkill({ body: "# Review\n\nUpdated policy." })]),
      bundledSkillsRoot,
    });
    expect(updated.installed).toContain("resource:resource-review");
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toContain("Updated policy.");

    const revoked = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(12, []),
      bundledSkillsRoot,
    });
    expect(revoked.removed).toContain("resource:resource-review@.agents/skills/review");
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(12);
  });

  it("serializes callers and prevents an older Team snapshot from rolling back a newer one", async () => {
    const newer = reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(18, [teamSkill()]),
      bundledSkillsRoot,
    });
    const older = reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(17, []),
      bundledSkillsRoot,
    });
    const [newResult, oldResult] = await Promise.all([newer, older]);

    expect(newResult.ok).toBe(true);
    expect(oldResult.staleTeamSnapshot).toBe(true);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(18);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
  });

  it("uses a deterministic suffix for Team Skill conflicts and never overwrites the user target", async () => {
    const userTarget = target(workspace, "codex", "review");
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user-owned review\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.teamSkills[0]?.name).toBe("review-first-tree");
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user-owned review\n");
    expect(existsSync(target(workspace, "codex", "review-first-tree"))).toBe(true);

    const retry = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(retry.teamSkills[0]?.name).toBe("review-first-tree");
  });

  it("refuses unowned Core targets and case-insensitive Core collisions", async () => {
    const exact = target(workspace, "codex", "first-tree-read");
    mkdirSync(exact, { recursive: true });
    writeFileSync(join(exact, "SKILL.md"), "user exact target\n");
    const caseVariant = target(workspace, "codex", "FIRST-TREE-WRITE");
    mkdirSync(caseVariant, { recursive: true });
    writeFileSync(join(caseVariant, "SKILL.md"), "user case variant\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toEqual(
      expect.arrayContaining(["core:first-tree-read", "core:first-tree-write"]),
    );
    expect(readFileSync(join(exact, "SKILL.md"), "utf-8")).toBe("user exact target\n");
    expect(readFileSync(join(caseVariant, "SKILL.md"), "utf-8")).toBe("user case variant\n");
    expect(existsSync(join(caseVariant, ".first-tree-managed.json"))).toBe(false);
  });

  it("rejects reserved, path-bearing, and Windows-device Team names without removing prior good targets", async () => {
    const initial = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(initial.ok).toBe(true);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [
        teamSkill({ name: "first-tree-read" }),
        teamSkill({ resourceId: "resource-path", name: "../escape" }),
        teamSkill({ resourceId: "resource-device", name: "CON" }),
      ]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.key)).toEqual(
      expect.arrayContaining(["resource:resource-review", "resource:resource-path", "resource:resource-device"]),
    );
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(existsSync(join(workspace, "escape"))).toBe(false);
  });

  it("rejects duplicate Team resource ids as an ambiguous snapshot and preserves the prior target", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [
        teamSkill({ name: "Review A" }),
        teamSkill({ name: "Review B", body: "different" }),
      ]),
      bundledSkillsRoot,
    });

    expect(result.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "duplicate resourceId in authoritative snapshot",
    });
    expect(result.teamSkills).toEqual([]);
    expect(readFileSync(join(target(workspace, "codex", "review"), "SKILL.md"), "utf-8")).toContain(
      "Check correctness first.",
    );
  });

  it("migrates only v1 targets with conservative ownership proof", async () => {
    const agentsRead = target(workspace, "codex", "first-tree-read");
    mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
    cpSync(join(bundledSkillsRoot, "first-tree-read"), agentsRead, { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/first-tree-read", join(workspace, ".claude", "skills", "first-tree-read"));

    const userWrite = target(workspace, "codex", "first-tree-write");
    mkdirSync(userWrite, { recursive: true });
    writeFileSync(join(userWrite, "SKILL.md"), "unowned same-name user Skill\n");
    writeLegacyState(workspace, []);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.installed).toContain("core:first-tree-read");
    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-write");
    expect(JSON.parse(readFileSync(join(agentsRead, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
      key: "core:first-tree-read",
    });
    expect(readFileSync(join(userWrite, "SKILL.md"), "utf-8")).toBe("unowned same-name user Skill\n");
    expect(existsSync(join(workspace, ".claude", "skills", "first-tree-read"))).toBe(false);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "current" });
  });

  it("does not follow a legacy managed-name symlink outside the workspace", async () => {
    const outside = join(sandbox, "outside-user-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "outside user content\n");
    const linkedTarget = target(workspace, "codex", "first-tree-seed");
    mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
    symlinkSync(outside, linkedTarget);
    writeLegacyState(workspace, ["first-tree-seed"]);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-seed");
    expect(readFileSync(join(outside, "SKILL.md"), "utf-8")).toBe("outside user content\n");
    expect(existsSync(linkedTarget)).toBe(true);
  });

  it.each([
    ["provider discovery root", ".agents/skills"],
    ["managed runtime root", ".first-tree-workspace"],
  ] as const)("fails closed before mutation when the %s is a symlink", async (_label, linkedRoot) => {
    const outside = join(sandbox, `outside-${linkedRoot.replaceAll("/", "-")}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "user-owned.txt"), "preserve\n");
    if (linkedRoot === ".agents/skills") {
      mkdirSync(join(workspace, ".agents"), { recursive: true });
    }
    symlinkSync(outside, join(workspace, linkedRoot));

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({
        key: "workspace",
        reason: expect.stringContaining("symlinked managed ancestor"),
      }),
    ]);
    expect(readdirSync(outside)).toEqual(["user-owned.txt"]);
    expect(readFileSync(join(outside, "user-owned.txt"), "utf-8")).toBe("preserve\n");
  });

  it("adopts an exact legacy Team materialization before moving it to the provider root", async () => {
    const skill = teamSkill({ resourceId: "Resource_ABC" });
    const legacyRoot = join(workspace, ".first-tree", "resources", "skills", skill.resourceId);
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, "SKILL.md"),
      [
        "---",
        `name: ${JSON.stringify(skill.name)}`,
        `description: ${JSON.stringify(skill.description)}`,
        `metadata: ${JSON.stringify(skill.metadata)}`,
        "---",
        "",
        skill.body,
        "",
      ].join("\n"),
    );

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(3, [skill]),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(result.removed).toContain("resource:Resource_ABC@.first-tree/resources/skills/Resource_ABC");
  });

  it.each([
    ["future", { schemaVersion: 99 }],
    ["corrupt", "{not json"],
  ] as const)("fails closed when managed state is %s", async (_label, rawState) => {
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      typeof rawState === "string" ? rawState : JSON.stringify(rawState),
    );

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.key).toBe("workspace");
    expect(existsSync(join(workspace, ".agents", "skills"))).toBe(false);
    expect(readFileSync(join(workspace, MANAGED_STATE_REL), "utf-8")).toBe(
      typeof rawState === "string" ? rawState : JSON.stringify(rawState),
    );
  });

  it.each([
    "prepared",
    "target_backed_up",
    "target_installed",
    "state_committed",
    "backup_cleaned",
  ] satisfies readonly ManagedSkillsCheckpoint[])("recovers an interrupted install/update at %s", async (checkpoint) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const v2Root = writeCoreBundle(sandbox, "2.0.0", `v2-${checkpoint}`);
    const interrupted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot: v2Root,
      testCrashAt: checkpoint,
    });
    expect(interrupted.ok).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot: v2Root,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(readFileSync(`${target(workspace, "codex", CORE_SKILL_NAMES[0])}/VERSION`, "utf-8")).toBe("2.0.0\n");
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
  });

  it.each([
    "prepared",
    "target_backed_up",
    "state_committed",
    "backup_cleaned",
  ] satisfies readonly ManagedSkillsCheckpoint[])("recovers an interrupted revoke at %s", async (checkpoint) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const interrupted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
      testCrashAt: checkpoint,
    });
    expect(interrupted.ok).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
  });

  it("aborts the workspace reconcile and preserves the journal when transaction recovery fails", async () => {
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      testFailureAt: "target_installed",
      testRecoveryFailure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({
        key: "workspace",
        reason: expect.stringContaining("reconciliation aborted with journal preserved"),
      }),
    ]);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[0]))).toBe(true);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[1]))).toBe(false);

    const journal = JSON.parse(readFileSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL), "utf-8"));
    expect(journal.target).toBe(`.agents/skills/${CORE_SKILL_NAMES[0]}`);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[1]))).toBe(true);
  });

  it("installs the new provider projection before retiring the previous provider targets", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    const switched = await reconcileManagedSkills({
      workspace,
      provider: "claude-code",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(switched.ok, JSON.stringify(switched.failures)).toBe(true);
    expect(switched.installed).toEqual(expect.arrayContaining(["core:first-tree-read", "resource:resource-review"]));
    expect(switched.removed).toEqual(
      expect.arrayContaining([
        "core:first-tree-read@.agents/skills/first-tree-read",
        "resource:resource-review@.agents/skills/review",
      ]),
    );
    expect(existsSync(target(workspace, "claude-code", "review"))).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it("rejects bundled symlinks and leaves the affected Core target absent", async () => {
    const readRoot = join(bundledSkillsRoot, "first-tree-read");
    rmSync(join(readRoot, "references", "guide.md"));
    symlinkSync("../SKILL.md", join(readRoot, "references", "guide.md"));

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-read");
    expect(existsSync(target(workspace, "codex", "first-tree-read"))).toBe(false);
  });

  it("requires Core VERSION and rejects non-portable bundle paths", async () => {
    rmSync(join(bundledSkillsRoot, "first-tree-read", "VERSION"));
    writeFileSync(join(bundledSkillsRoot, "first-tree-write", "references", "CON.txt"), "not portable to Windows\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "core:first-tree-read",
          reason: expect.stringContaining("missing VERSION"),
        }),
        expect.objectContaining({
          key: "core:first-tree-write",
          reason: expect.stringContaining("unsafe path segment"),
        }),
      ]),
    );
    expect(existsSync(target(workspace, "codex", "first-tree-read"))).toBe(false);
    expect(existsSync(target(workspace, "codex", "first-tree-write"))).toBe(false);
  });

  it("keeps one persistent regular lock inode across reconciliations", async () => {
    const lockPath = join(workspace, MANAGED_SKILLS_LOCK_REL);

    const first = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(first.ok, JSON.stringify(first.failures)).toBe(true);
    const firstStats = lstatSync(lockPath);
    expect(firstStats.isFile()).toBe(true);

    const second = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(second.ok, JSON.stringify(second.failures)).toBe(true);
    const secondStats = lstatSync(lockPath);
    expect(secondStats.isFile()).toBe(true);
    expect(secondStats.dev).toBe(firstStats.dev);
    expect(secondStats.ino).toBe(firstStats.ino);
  });
});
