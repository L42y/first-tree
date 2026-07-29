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
import { strToU8, type ZipOptions, zipSync } from "fflate";
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

const BUNDLE_ID_A = "11111111-1111-4111-8111-111111111111";
const BUNDLE_ID_B = "22222222-2222-4222-8222-222222222222";

type TestZipEntry = Uint8Array | [Uint8Array, ZipOptions];

function makeSkillZip(
  entries: Record<string, TestZipEntry> = {},
  options: Readonly<{ wrapper?: string; name?: string }> = {},
): Buffer {
  const prefix = options.wrapper ? `${options.wrapper}/` : "";
  return Buffer.from(
    zipSync(
      {
        [`${prefix}SKILL.md`]: strToU8(
          [
            "---",
            `name: ${options.name ?? "review"}`,
            "description: Bundle review instructions.",
            "metadata:",
            "  owner: platform",
            "  retained: true",
            "---",
            "",
            "# Bundle review",
            "",
            "Keep this body byte-for-byte when only the name changes.",
            "",
          ].join("\n"),
        ),
        ...Object.fromEntries(Object.entries(entries).map(([path, value]) => [`${prefix}${path}`, value])),
      },
      { level: 6 },
    ),
  );
}

function bundleSkill(
  bytes: Buffer,
  overrides: Partial<RuntimeResourceSkill> = {},
  attachmentId = BUNDLE_ID_A,
): RuntimeResourceSkill {
  return teamSkill({
    name: "review",
    body: "INLINE FALLBACK MUST NEVER BE MATERIALIZED",
    bundle: {
      attachmentId,
      format: "zip",
      sizeBytes: bytes.byteLength,
    },
    ...overrides,
  });
}

function zipWithEncryptedFlag(bytes: Buffer): Buffer {
  const patched = Buffer.from(bytes);
  for (let offset = 0; offset <= patched.byteLength - 10; offset++) {
    const signature = patched.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      patched.writeUInt16LE(patched.readUInt16LE(offset + 6) | 0x1, offset + 6);
    } else if (signature === 0x02014b50) {
      patched.writeUInt16LE(patched.readUInt16LE(offset + 8) | 0x1, offset + 8);
    }
  }
  return patched;
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

  it("installs complete root and wrapped Team ZIPs with nested, executable, and binary files", async () => {
    const binary = Uint8Array.from([0, 255, 1, 128, 64]);
    const rootZip = makeSkillZip({
      "scripts/run.sh": [strToU8("#!/bin/sh\necho bundle\n"), { os: 3, attrs: 0o100777 << 16 }],
      "references/guide.md": strToU8("# Guide\n"),
      "references/nested/deep.md": strToU8("deep\n"),
      "assets/pixel.bin": binary,
    });
    const resolver = async (): Promise<Buffer> => rootZip;
    const rootResult = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(rootZip)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });

    expect(rootResult.ok, JSON.stringify(rootResult.failures)).toBe(true);
    const installed = target(workspace, "codex", "review");
    expect(readFileSync(join(installed, "scripts", "run.sh"), "utf-8")).toContain("echo bundle");
    expect(lstatSync(join(installed, "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(installed, "references", "nested", "deep.md"), "utf-8")).toBe("deep\n");
    expect(readFileSync(join(installed, "assets", "pixel.bin"))).toEqual(Buffer.from(binary));
    expect(readFileSync(join(installed, "SKILL.md"), "utf-8")).not.toContain("INLINE FALLBACK");

    const wrappedZip = makeSkillZip(
      {
        "scripts/wrapped.sh": strToU8("echo wrapped\n"),
        "assets/wrapped.bin": Uint8Array.from([9, 8, 7]),
      },
      { wrapper: "review-skill" },
    );
    const wrappedResult = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(wrappedZip, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: async () => wrappedZip,
    });
    expect(wrappedResult.ok, JSON.stringify(wrappedResult.failures)).toBe(true);
    expect(readFileSync(join(installed, "scripts", "wrapped.sh"), "utf-8")).toBe("echo wrapped\n");
    expect(existsSync(join(installed, "review-skill"))).toBe(false);
  });

  it("normalizes uploaded Unix modes so owner access is always usable and unsafe writes are removed", async () => {
    const bundle = makeSkillZip({
      "locked/": [new Uint8Array(), { os: 3, attrs: 0o040000 << 16 }],
      "locked/run.sh": [strToU8("echo safe\n"), { os: 3, attrs: 0o100000 << 16 }],
    });
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    const installed = target(workspace, "codex", "review");
    expect(lstatSync(join(installed, "locked")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(installed, "locked", "run.sh")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(installed, "locked", "run.sh"), "utf-8")).toBe("echo safe\n");
  });

  it("rewrites only the manifest name for an allocated collision target", async () => {
    const userTarget = target(workspace, "codex", "review");
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user-owned review\n");
    const bundle = makeSkillZip({
      "scripts/run.sh": strToU8("echo retained\n"),
      "assets/data.bin": Uint8Array.from([3, 1, 4]),
    });

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.teamSkills[0]?.name).toBe("review-first-tree");
    const markdown = readFileSync(`${target(workspace, "codex", "review-first-tree")}/SKILL.md`, "utf-8");
    expect(markdown).toContain("name: review-first-tree");
    expect(markdown).toContain("owner: platform");
    expect(markdown).toContain("retained: true");
    expect(markdown).toContain("Keep this body byte-for-byte when only the name changes.");
    expect(readFileSync(`${target(workspace, "codex", "review-first-tree")}/assets/data.bin`)).toEqual(
      Buffer.from([3, 1, 4]),
    );
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user-owned review\n");
  });

  it("uses immutable bundle revision identity, repairs drift, and preserves last-known-good on resolve failure", async () => {
    const firstBundle = makeSkillZip({ "assets/version.txt": strToU8("one\n") });
    let currentBytes = firstBundle;
    let resolveError: Error | null = null;
    let fetches = 0;
    const resolver = async (): Promise<Buffer> => {
      fetches++;
      if (resolveError) throw resolveError;
      return currentBytes;
    };
    const firstSkill = bundleSkill(firstBundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    const installed = target(workspace, "codex", "review");
    expect(fetches).toBe(1);

    const unchanged = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(unchanged.skipped).toContain("resource:resource-review");
    expect(fetches).toBe(1);

    writeFileSync(join(installed, "assets", "version.txt"), "drift\n");
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(fetches).toBe(2);
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("one\n");

    const secondBundle = makeSkillZip({ "assets/version.txt": strToU8("two\n") });
    currentBytes = secondBundle;
    resolveError = new Error("temporary attachment download failure");
    const failedUpdate = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(failedUpdate.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "temporary attachment download failure",
    });
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("one\n");

    resolveError = null;
    const updated = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(updated.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("two\n");
  });

  it("never invents an inline copy when a first bundle install cannot resolve", async () => {
    const bundle = makeSkillZip();
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-review",
        reason: expect.stringContaining("bundle resolver is unavailable"),
      }),
    );
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it.each([
    [
      "traversal",
      () =>
        makeSkillZip({
          "../escape.txt": strToU8("escape"),
        }),
      "invalid",
    ],
    [
      "absolute path",
      () =>
        makeSkillZip({
          "/absolute.txt": strToU8("escape"),
        }),
      "absolute",
    ],
    [
      "backslash path",
      () =>
        makeSkillZip({
          "scripts\\escape.sh": strToU8("escape"),
        }),
      "invalid",
    ],
    [
      "case-folded duplicate",
      () =>
        makeSkillZip({
          "assets/Icon.bin": Uint8Array.from([1]),
          "assets/icon.bin": Uint8Array.from([2]),
        }),
      "duplicate case-folded",
    ],
    [
      "Unicode-normalized duplicate",
      () =>
        makeSkillZip({
          "assets/Café.bin": Uint8Array.from([1]),
          "assets/Cafe\u0301.bin": Uint8Array.from([2]),
        }),
      "duplicate case-folded",
    ],
    [
      "reserved ownership marker",
      () =>
        makeSkillZip({
          ".first-tree-managed.json": strToU8("{}"),
        }),
      "reserved",
    ],
    [
      "reserved ownership marker tree",
      () =>
        makeSkillZip({
          ".first-tree-managed.json/child": strToU8("{}"),
        }),
      "reserved",
    ],
    [
      "ambiguous second manifest",
      () =>
        makeSkillZip({
          "nested/SKILL.md": strToU8("---\nname: nested\ndescription: nested\n---\n"),
        }),
      "exactly one SKILL.md",
    ],
    [
      "symlink",
      () =>
        makeSkillZip({
          "scripts/link": [strToU8("../SKILL.md"), { os: 3, attrs: 0o120777 << 16 }],
        }),
      "symlinks",
    ],
    [
      "special file",
      () =>
        makeSkillZip({
          "scripts/fifo": [new Uint8Array(), { os: 3, attrs: 0o010644 << 16 }],
        }),
      "special files",
    ],
    ["encrypted entry", () => zipWithEncryptedFlag(makeSkillZip()), "encrypted"],
    [
      "excessive depth",
      () =>
        makeSkillZip({
          [`${Array.from({ length: 18 }, (_, index) => `d${index}`).join("/")}/deep.txt`]: strToU8("deep"),
        }),
      "directory depth",
    ],
    [
      "Windows-reserved segment",
      () =>
        makeSkillZip({
          "references/CON/file.txt": strToU8("unsafe"),
        }),
      "Windows-reserved",
    ],
    [
      "overlong segment",
      () =>
        makeSkillZip({
          [`assets/${"a".repeat(241)}`]: strToU8("unsafe"),
        }),
      "portable length",
    ],
    [
      "overlong relative path",
      () =>
        makeSkillZip({
          [`${Array.from({ length: 4 }, () => "a".repeat(200)).join("/")}/file.txt`]: strToU8("unsafe"),
        }),
      "relative path exceeds portable length",
    ],
    [
      "excessive file count",
      () =>
        makeSkillZip(
          Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [`assets/${index}.txt`, strToU8(String(index))]),
          ),
        ),
      "file count",
    ],
    [
      "excessive entry count",
      () =>
        makeSkillZip(
          Object.fromEntries(
            Array.from({ length: 512 }, (_, index) => [
              `empty/${index}/`,
              [new Uint8Array(), { os: 3, attrs: 0o040755 << 16 }] as TestZipEntry,
            ]),
          ),
        ),
      "entry count",
    ],
    [
      "regular-file wrapper anchor",
      () =>
        Buffer.from(
          zipSync({
            wrapper: strToU8("not a directory"),
            "wrapper/SKILL.md": strToU8("---\nname: review\ndescription: review\n---\n"),
          }),
        ),
      "anchor must be a directory",
    ],
    [
      "non-exact manifest filename",
      () =>
        Buffer.from(
          zipSync({
            "skill.md": strToU8("---\nname: review\ndescription: review\n---\n"),
          }),
        ),
      "root or inside one top-level directory",
    ],
    [
      "oversized expansion",
      () =>
        makeSkillZip({
          "assets/large.bin": new Uint8Array(25 * 1024 * 1024 + 1),
        }),
      "max size",
    ],
  ])("rejects a %s ZIP without escaping or corrupting the prior target", async (_label, buildZip, reason) => {
    const prior = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(prior.ok).toBe(true);
    const priorMarkdown = readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8");
    const malicious = buildZip();

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(malicious, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: async () => malicious,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-review",
        reason: expect.stringContaining(reason),
      }),
    );
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toBe(priorMarkdown);
    expect(existsSync(join(workspace, "escape.txt"))).toBe(false);
    expect(existsSync(join(workspace, "absolute.txt"))).toBe(false);
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
