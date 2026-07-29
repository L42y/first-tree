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
import {
  type AgentRuntimeConfig,
  type RuntimeProvider,
  type RuntimeResourceSkill,
  type RuntimeTeamSkillAttachmentEntry,
  type RuntimeTeamSkillEntry,
  TEAM_SKILL_BUNDLE_LIMITS,
} from "@first-tree/shared";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import {
  authoritativeTeamSkillSnapshot,
  type ManagedSkillAttachmentFetcher,
  type ManagedSkillsCheckpoint,
  providerSkillRoot,
  reconcileManagedSkills,
  teamSkillSnapshotFromConfig,
} from "../runtime/managed-skills.js";
import {
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_SKILLS_LOCK_REL,
  MANAGED_STATE_REL,
  readManagedState,
  readManagedStateResult,
} from "../runtime/managed-state.js";
import { extractTeamSkillBundle } from "../runtime/team-skill-bundle.js";

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

function teamBundleZip(
  name = "review",
  body = "# Review\n\nUse the supporting files.",
  wrapper = "",
  supporting: Record<string, Uint8Array> = {
    "scripts/run.sh": strToU8("#!/bin/sh\necho bundled\n"),
    "references/policy.md": strToU8("bundled policy\n"),
  },
): Buffer {
  const prefix = wrapper ? `${wrapper}/` : "";
  const entries: Record<string, Uint8Array> = {
    [`${prefix}SKILL.md`]: strToU8(
      ["---", `name: ${name}`, "description: Review changes.", "---", "", body, ""].join("\n"),
    ),
  };
  for (const [path, bytes] of Object.entries(supporting)) entries[`${prefix}${path}`] = bytes;
  return Buffer.from(zipSync(entries));
}

function maximumAdmissibleTeamBundleZip(): Buffer {
  const manifest = strToU8(
    ["---", "name: review", "description: Review changes.", "---", "", "# Review", "", "At the limit.", ""].join("\n"),
  );
  const entries: Record<string, Uint8Array> = { "SKILL.md": manifest };
  const tinyFiles = 251;
  for (let index = 0; index < tinyFiles; index++) {
    entries[`references/tiny-${index}.txt`] = Uint8Array.of(index % 256);
  }
  for (let index = 0; index < 3; index++) {
    entries[`references/full-${index}.bin`] = new Uint8Array(TEAM_SKILL_BUNDLE_LIMITS.fileBytes);
  }
  const remaining =
    TEAM_SKILL_BUNDLE_LIMITS.totalBytes - manifest.byteLength - tinyFiles - 3 * TEAM_SKILL_BUNDLE_LIMITS.fileBytes;
  entries["references/remainder.bin"] = new Uint8Array(remaining);
  return Buffer.from(zipSync(entries));
}

function attachmentEntry(
  attachmentId: string,
  bytes: Buffer,
  overrides: Partial<RuntimeTeamSkillAttachmentEntry> = {},
): RuntimeTeamSkillAttachmentEntry {
  return {
    kind: "attachment-bundle",
    resourceId: "resource-review",
    name: "review",
    description: "Review changes.",
    attachmentId,
    sizeBytes: bytes.byteLength,
    ...overrides,
  };
}

function attachmentSnapshot(resourceConfigVersion: number, entries: readonly RuntimeTeamSkillEntry[]) {
  return {
    kind: "authoritative" as const,
    resourceConfigVersion,
    entries,
  };
}

function runtimeConfig(
  version: number,
  resourceSkills: readonly RuntimeResourceSkill[],
  teamSkillSnapshot?: unknown,
): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version,
    payload: {
      kind: "codex",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [...resourceSkills],
      ...(teamSkillSnapshot === undefined ? {} : { teamSkillSnapshot }),
      reasoningEffort: "high",
      serviceTier: "default",
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: "member-1",
  };
}

function mutateFirstZipEntry(
  source: Buffer,
  mutateLocal: (bytes: Buffer, offset: number) => void,
  mutateCentral: (bytes: Buffer, offset: number) => void,
): Buffer {
  const bytes = Buffer.from(source);
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (local < 0 || central < 0) throw new Error("fixture ZIP headers are missing");
  mutateLocal(bytes, local);
  mutateCentral(bytes, central);
  return bytes;
}

function encryptedZip(source: Buffer): Buffer {
  return mutateFirstZipEntry(
    source,
    (bytes, offset) => bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 0x1, offset + 6),
    (bytes, offset) => bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 0x1, offset + 8),
  );
}

function unixTypeZip(source: Buffer, mode: number): Buffer {
  return mutateFirstZipEntry(
    source,
    () => {},
    (bytes, offset) => {
      bytes.writeUInt16LE((3 << 8) | 20, offset + 4);
      bytes.writeUInt32LE((mode << 16) >>> 0, offset + 38);
    },
  );
}

function mismatchedSizeZip(source: Buffer): Buffer {
  return mutateFirstZipEntry(
    source,
    (bytes, offset) => bytes.writeUInt32LE(bytes.readUInt32LE(offset + 22) + 1, offset + 22),
    (bytes, offset) => bytes.writeUInt32LE(bytes.readUInt32LE(offset + 24) + 1, offset + 24),
  );
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

  it("uses a recognized snapshot exclusively and preserves LKG for malformed or future snapshots", () => {
    const legacy = teamSkill();
    const absent = teamSkillSnapshotFromConfig(runtimeConfig(3, [legacy]));
    expect(absent).toEqual(authoritativeTeamSkillSnapshot(3, [legacy]));

    const recognized = teamSkillSnapshotFromConfig(
      runtimeConfig(4, [legacy], { kind: "authoritative", schemaVersion: 1, entries: [] }),
    );
    expect(recognized).toEqual(attachmentSnapshot(4, []));

    expect(
      teamSkillSnapshotFromConfig(
        runtimeConfig(5, [legacy], { kind: "authoritative", schemaVersion: 1, entries: "invalid" }),
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      teamSkillSnapshotFromConfig(runtimeConfig(6, [legacy], { kind: "authoritative", schemaVersion: 2, entries: [] })),
    ).toEqual({ kind: "unavailable" });
  });

  it.each([
    "",
    "review-wrapper",
  ])("installs a complete %s attachment bundle, skips unchanged downloads, and repairs supporting-file drift", async (wrapper) => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const bytes = teamBundleZip("review", undefined, wrapper);
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => ({
      bytes,
      size: bytes.byteLength,
    }));
    const snapshot = attachmentSnapshot(20, [attachmentEntry(attachmentId, bytes)]);

    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);
    expect(readFileSync(join(target(workspace, "codex", "review"), "scripts", "run.sh"), "utf-8")).toContain("bundled");
    expect(readFileSync(join(target(workspace, "codex", "review"), "references", "policy.md"), "utf-8")).toContain(
      "bundled policy",
    );
    const marker = readFileSync(join(target(workspace, "codex", "review"), ".first-tree-managed.json"), "utf-8");
    expect(marker).not.toContain(attachmentId);
    expect(readFileSync(join(workspace, MANAGED_STATE_REL), "utf-8")).not.toContain(attachmentId);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(fetchAttachment).toHaveBeenCalledWith({
      id: attachmentId,
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 15_000,
    });

    const unchanged = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(unchanged.skipped).toContain("resource:resource-review");
    expect(fetchAttachment).toHaveBeenCalledTimes(1);

    writeFileSync(join(target(workspace, "codex", "review"), "references", "policy.md"), "drift\n");
    const repaired = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(repaired.installed).toContain("resource:resource-review");
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(target(workspace, "codex", "review"), "references", "policy.md"), "utf-8")).toContain(
      "bundled policy",
    );
  });

  it("installs an archive at the exact file and byte limits plus generated managed metadata", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const bytes = maximumAdmissibleTeamBundleZip();
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => ({
      bytes,
      size: bytes.byteLength,
    }));

    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(21, [attachmentEntry(attachmentId, bytes)]),
      bundledSkillsRoot,
      fetchAttachment,
    });

    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);
    expect(existsSync(join(target(workspace, "codex", "review"), ".first-tree-managed.json"))).toBe(true);
    expect(existsSync(join(target(workspace, "codex", "review"), "references", "remainder.bin"))).toBe(true);
  });

  it("preserves LKG on download failure and retries the same config version", async () => {
    const oldId = "11111111-1111-4111-8111-111111111111";
    const newId = "22222222-2222-4222-8222-222222222222";
    const oldBytes = teamBundleZip("review", "# Review\n\nOld bundle.");
    const newBytes = teamBundleZip("review", "# Review\n\nNew bundle.");
    const responses = new Map<string, Buffer>([[oldId, oldBytes]]);
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async ({ id }) => {
      const bytes = responses.get(id);
      if (!bytes) throw new Error("missing fixture attachment");
      return { bytes, size: bytes.byteLength };
    });

    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(30, [attachmentEntry(oldId, oldBytes)]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    const failed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(31, [attachmentEntry(newId, newBytes)]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(failed.ok).toBe(false);
    expect(readFileSync(join(target(workspace, "codex", "review"), "SKILL.md"), "utf-8")).toContain("Old bundle.");
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(31);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);

    responses.set(newId, newBytes);
    const retried = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(31, [attachmentEntry(newId, newBytes)]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(retried.installed).toContain("resource:resource-review");
    expect(readFileSync(join(target(workspace, "codex", "review"), "SKILL.md"), "utf-8")).toContain("New bundle.");
  });

  it("leaves no target, staging directory, or journal after a first-install bundle failure", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const valid = teamBundleZip();
    const invalid = Buffer.alloc(valid.byteLength);
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => ({
      bytes: invalid,
      size: invalid.byteLength,
    }));

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(35, [attachmentEntry(attachmentId, valid)]),
      bundledSkillsRoot,
      fetchAttachment,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
    expect(
      readdirSync(join(workspace, ".agents", "skills")).some(
        (name) => name.startsWith(".review.ft-") && name.endsWith(".staging"),
      ),
    ).toBe(false);
  });

  it("does not replace a user target created while an attachment is downloading", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const bytes = teamBundleZip();
    const userTarget = target(workspace, "codex", "review");
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => {
      mkdirSync(userTarget, { recursive: true });
      writeFileSync(join(userTarget, "SKILL.md"), "user content created during download\n");
      return { bytes, size: bytes.byteLength };
    });

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(36, [attachmentEntry(attachmentId, bytes)]),
      bundledSkillsRoot,
      fetchAttachment,
    });

    expect(result.failures).toContainEqual({
      key: "resource:resource-review",
      reason: expect.stringContaining("target created while staging"),
    });
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user content created during download\n");
    expect(existsSync(join(userTarget, ".first-tree-managed.json"))).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
    expect(
      readdirSync(join(workspace, ".agents", "skills")).some(
        (name) => name.startsWith(".review.ft-") && name.endsWith(".staging"),
      ),
    ).toBe(false);
  });

  it("preserves user content that replaces a previously managed target on update and revoke", async () => {
    const attachmentIdV1 = "11111111-1111-4111-8111-111111111111";
    const attachmentIdV2 = "22222222-2222-4222-8222-222222222222";
    const bytesV1 = teamBundleZip("review", "# Review\n\nManaged v1.");
    const bytesV2 = teamBundleZip("review", "# Review\n\nManaged v2.");
    const responses = new Map<string, Buffer>([
      [attachmentIdV1, bytesV1],
      [attachmentIdV2, bytesV2],
    ]);
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async ({ id }) => {
      const bytes = responses.get(id);
      if (!bytes) throw new Error("missing fixture attachment");
      return { bytes, size: bytes.byteLength };
    });
    const userTarget = target(workspace, "codex", "review");

    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(37, [attachmentEntry(attachmentIdV1, bytesV1)]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);

    rmSync(userTarget, { recursive: true, force: true });
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user replacement\n");

    const update = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(38, [attachmentEntry(attachmentIdV2, bytesV2)]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(update.failures).toContainEqual({
      key: "resource:resource-review",
      reason: expect.stringContaining("refusing to mutate unowned managed Skill target"),
    });
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user replacement\n");

    const revoke = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(39, []),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(revoke.failures).toContainEqual({
      key: "resource:resource-review",
      reason: expect.stringContaining("cleanup .agents/skills/review: refusing to mutate unowned managed Skill target"),
    });
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user replacement\n");
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
  });

  it("preserves unowned directories even when their names resemble internal staging paths", async () => {
    const skillsRoot = join(workspace, ".agents", "skills");
    const userDirectory = join(skillsRoot, ".review.ft-0123456789abcdef.staging");
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(join(userDirectory, "keep.txt"), "keep\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(readFileSync(join(userDirectory, "keep.txt"), "utf-8")).toBe("keep\n");
  });

  it("materializes explicit empty directories from root and wrapped bundles", async () => {
    for (const wrapper of ["", "wrapped"]) {
      const destination = join(workspace, `empty-directory-${wrapper || "root"}`);
      mkdirSync(destination, { recursive: true });
      const bytes = teamBundleZip("review", "# Review\n\nEmpty template.", wrapper, {
        "templates/empty/": new Uint8Array(),
      });

      await extractTeamSkillBundle(bytes, destination);

      expect(lstatSync(join(destination, "templates", "empty")).isDirectory()).toBe(true);
      expect(readdirSync(join(destination, "templates", "empty"))).toEqual([]);
    }
  });

  it("preserves an unavailable Skill while other entries update, then revokes only on omission", async () => {
    const reviewV1 = teamBundleZip("review", "# Review\n\nReview v1.");
    const deployV1 = teamBundleZip("deploy", "# Deploy\n\nDeploy v1.");
    const deployV2 = teamBundleZip("deploy", "# Deploy\n\nDeploy v2.");
    const ids = {
      review: "11111111-1111-4111-8111-111111111111",
      deployV1: "22222222-2222-4222-8222-222222222222",
      deployV2: "33333333-3333-4333-8333-333333333333",
    };
    const responses = new Map<string, Buffer>([
      [ids.review, reviewV1],
      [ids.deployV1, deployV1],
      [ids.deployV2, deployV2],
    ]);
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async ({ id }) => {
      const bytes = responses.get(id);
      if (!bytes) throw new Error("missing fixture attachment");
      return { bytes, size: bytes.byteLength };
    });
    const review = attachmentEntry(ids.review, reviewV1);
    const deploy = attachmentEntry(ids.deployV1, deployV1, {
      resourceId: "resource-deploy",
      name: "deploy",
    });

    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(40, [review, deploy]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    const partial = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(41, [
        { kind: "unavailable", resourceId: "resource-review", reason: "skill_bundle_unavailable" },
        attachmentEntry(ids.deployV2, deployV2, { resourceId: "resource-deploy", name: "deploy" }),
      ]),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(partial.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "skill_bundle_unavailable",
    });
    expect(readFileSync(join(target(workspace, "codex", "review"), "SKILL.md"), "utf-8")).toContain("Review v1.");
    expect(readFileSync(join(target(workspace, "codex", "deploy"), "SKILL.md"), "utf-8")).toContain("Deploy v2.");

    const revoked = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(42, []),
      bundledSkillsRoot,
      fetchAttachment,
    });
    expect(revoked.removed).toEqual(
      expect.arrayContaining([
        "resource:resource-review@.agents/skills/review",
        "resource:resource-deploy@.agents/skills/deploy",
      ]),
    );
  });

  it("rewrites a bundle manifest to a deterministic alternate name without changing supporting files", async () => {
    const userTarget = target(workspace, "codex", "review");
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user-owned review\n");
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const bytes = teamBundleZip("Review");
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => ({
      bytes,
      size: bytes.byteLength,
    }));

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: attachmentSnapshot(50, [attachmentEntry(attachmentId, bytes, { name: "Review" })]),
      bundledSkillsRoot,
      fetchAttachment,
    });

    expect(result.teamSkills[0]?.name).toBe("review-first-tree");
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user-owned review\n");
    expect(readFileSync(join(target(workspace, "codex", "review-first-tree"), "SKILL.md"), "utf-8")).toContain(
      "name: review-first-tree",
    );
    expect(
      readFileSync(join(target(workspace, "codex", "review-first-tree"), "references", "policy.md"), "utf-8"),
    ).toContain("bundled policy");
  });

  it("installs the new provider target before removing the old provider bundle target", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const bytes = teamBundleZip();
    const fetchAttachment = vi.fn<ManagedSkillAttachmentFetcher>(async () => ({
      bytes,
      size: bytes.byteLength,
    }));
    const snapshot = attachmentSnapshot(60, [attachmentEntry(attachmentId, bytes)]);

    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      fetchAttachment,
    });
    const switched = await reconcileManagedSkills({
      workspace,
      provider: "claude-code",
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      fetchAttachment,
    });

    expect(switched.installed).toContain("resource:resource-review");
    expect(existsSync(target(workspace, "claude-code", "review"))).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it.each([
    [
      "path traversal",
      Buffer.from(
        zipSync({
          "../SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
        }),
      ),
    ],
    [
      "absolute path",
      Buffer.from(
        zipSync({
          "/SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
        }),
      ),
    ],
    [
      "backslash path",
      Buffer.from(
        zipSync({
          "wrapped\\SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
        }),
      ),
    ],
    [
      "wrong-case manifest",
      Buffer.from(
        zipSync({
          "skill.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
        }),
      ),
    ],
    [
      "case-colliding files",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          "scripts/run.sh": strToU8("one"),
          "scripts/RUN.sh": strToU8("two"),
        }),
      ),
    ],
    [
      "wrapped-root extra content",
      Buffer.from(
        zipSync({
          "wrapped/SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          "outside.txt": strToU8("outside"),
        }),
      ),
    ],
    [
      "Windows device name",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          "scripts/CON": strToU8("device"),
        }),
      ),
    ],
    [
      "trailing-dot segment",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          "references./policy.md": strToU8("unsafe"),
        }),
      ),
    ],
    [
      "reserved ownership marker",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          ".first-tree-managed.json": strToU8("{}"),
        }),
      ),
    ],
    [
      "case-varied ownership marker",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          ".FIRST-TREE-MANAGED.JSON": strToU8("{}"),
        }),
      ),
    ],
    [
      "ownership marker child",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          ".first-tree-managed.json/data": strToU8("unsafe"),
        }),
      ),
    ],
    [
      "file parent",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          scripts: strToU8("file"),
          "scripts/run.sh": strToU8("nested"),
        }),
      ),
    ],
    [
      "wrapped-root outside empty directory",
      Buffer.from(
        zipSync({
          "wrapped/SKILL.md": strToU8("---\nname: review\ndescription: Review changes.\n---\n"),
          "outside/": new Uint8Array(),
        }),
      ),
    ],
    [
      "overlong path segment",
      teamBundleZip("review", "# Review\n\nUnsafe.", "", {
        [`references/${"a".repeat(TEAM_SKILL_BUNDLE_LIMITS.segmentCodeUnits + 1)}.txt`]: strToU8("unsafe"),
      }),
    ],
    [
      "overlong extracted path",
      teamBundleZip("review", "# Review\n\nUnsafe.", "", {
        [`${Array.from({ length: 8 }, () => "a".repeat(100)).join("/")}/file.txt`]: strToU8("unsafe"),
      }),
    ],
    ["encrypted entry", encryptedZip(teamBundleZip())],
    ["symlink entry", unixTypeZip(teamBundleZip(), 0o120777)],
    ["special entry", unixTypeZip(teamBundleZip(), 0o010644)],
    ["declared size mismatch", mismatchedSizeZip(teamBundleZip())],
  ])("rejects a Team Skill ZIP with %s", async (_label, bytes) => {
    const destination = join(workspace, "zip-attack");
    mkdirSync(destination, { recursive: true });
    await expect(extractTeamSkillBundle(bytes, destination)).rejects.toThrow();
    expect(existsSync(join(workspace, "SKILL.md"))).toBe(false);
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
