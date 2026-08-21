import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyAllSkillPayloads,
  copyPrivateSkillVariants,
  resetSkillsTarget,
  SKILL_PAYLOAD_REPO_ROOT,
  withTrustedSkillsTarget,
} from "../../../scripts/copy-skill-payloads.mjs";

const SCRIPT_PATH = join(SKILL_PAYLOAD_REPO_ROOT, "scripts", "copy-skill-payloads.mjs");
const CLI_PACKAGE_DIR = join(SKILL_PAYLOAD_REPO_ROOT, "apps", "cli");

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), name));
  tmpDirs.push(dir);
  return dir;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Create <parent>/skills/sentinel.txt plus a sibling control file and return
// their hashes so a rejected operation can prove zero mutation inside and out.
function plantSentinels(parent: string): {
  sentinel: string;
  control: string;
  sentinelHash: string;
  controlHash: string;
} {
  const skillsDir = join(parent, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const sentinel = join(skillsDir, "sentinel.txt");
  const control = join(parent, "control.txt");
  writeFileSync(sentinel, "protected-bytes");
  writeFileSync(control, "control-bytes");
  return { sentinel, control, sentinelHash: sha256(sentinel), controlHash: sha256(control) };
}

function expectUnchanged(fixture: {
  sentinel: string;
  control: string;
  sentinelHash: string;
  controlHash: string;
}): void {
  expect(sha256(fixture.sentinel)).toBe(fixture.sentinelHash);
  expect(sha256(fixture.control)).toBe(fixture.controlHash);
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: "utf8" });
}

// Minimal repo shape accepted by capability creation: a public skills root
// plus the exactly-registered local-context private variants.
function makeFakeRepo(root: string): void {
  mkdirSync(join(root, "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "demo-skill", "SKILL.md"), "# demo\n");
  for (const name of ["first-tree-read", "first-tree-write"]) {
    mkdirSync(join(root, "skill-variants", "local-context", name), { recursive: true });
    writeFileSync(join(root, "skill-variants", "local-context", name, "SKILL.md"), `# ${name}\n`);
  }
}

// Assert that transaction construction fails with `message` before invoking
// the callback — i.e. before any mutation can happen.
function expectTransactionRejected(options: Record<string, unknown>, message: string): void {
  let ran = false;
  expect(() =>
    withTrustedSkillsTarget(options, () => {
      ran = true;
    }),
  ).toThrow(message);
  expect(ran).toBe(false);
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("copy-skill-payloads CLI", () => {
  it("copies public skills and private variants from a canonical apps/cli cwd (fake repo in temp)", () => {
    const fakeRoot = tempDir("first-tree-skill-target-fakerepo-");
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    copyFileSync(
      join(SKILL_PAYLOAD_REPO_ROOT, "scripts", "copy-skill-payloads.mjs"),
      join(fakeRoot, "scripts", "copy-skill-payloads.mjs"),
    );
    mkdirSync(join(fakeRoot, "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(fakeRoot, "skills", "demo-skill", "SKILL.md"), "# demo\n");
    for (const name of ["first-tree-read", "first-tree-write"]) {
      mkdirSync(join(fakeRoot, "skill-variants", "local-context", name), { recursive: true });
      writeFileSync(join(fakeRoot, "skill-variants", "local-context", name, "SKILL.md"), `# ${name}\n`);
    }
    const fakeCli = join(fakeRoot, "apps", "cli");
    mkdirSync(fakeCli, { recursive: true });

    const result = spawnSync(
      process.execPath,
      [join(fakeRoot, "scripts", "copy-skill-payloads.mjs"), "--target", "skills", "--clean"],
      {
        cwd: fakeCli,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("copied 1 public skill(s) + 2 private variant(s)");
    expect(readFileSync(join(fakeCli, "skills", "demo-skill", "SKILL.md"), "utf8")).toBe("# demo\n");
    for (const name of ["first-tree-read", "first-tree-write"]) {
      expect(readFileSync(join(fakeCli, "skills", ".variants", "local-context", name, "SKILL.md"), "utf8")).toBe(
        `# ${name}\n`,
      );
    }
  });

  it("rejects an arbitrary absolute target before any mutation", () => {
    const protectedDir = tempDir("first-tree-skill-target-absolute-");
    const fixture = plantSentinels(protectedDir);

    const result = runCli(["--target", join(protectedDir, "skills"), "--clean"], CLI_PACKAGE_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be the literal "skills"');
    expectUnchanged(fixture);
  });

  it("rejects a `..` target that escapes the package directory", () => {
    const fixture = plantSentinels(tempDir("first-tree-skill-target-dotdot-"));

    const result = runCli(["--target", "../..", "--clean"], CLI_PACKAGE_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be the literal "skills"');
    expect(existsSync(join(SKILL_PAYLOAD_REPO_ROOT, "apps", "skills"))).toBe(false);
    expectUnchanged(fixture);
  });

  it.each([
    "foo/../skills",
    "skills/../skills",
    "./skills",
    "skills/",
  ])("rejects the non-literal target that normalizes to skills: %s", (target) => {
    const result = runCli(["--target", target, "--clean"], CLI_PACKAGE_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be the literal "skills"');
    expect(existsSync(join(CLI_PACKAGE_DIR, "skills"))).toBe(false);
  });

  it("rejects a non-`skills` leaf inside the package directory", () => {
    const result = runCli(["--target", "src", "--clean"], CLI_PACKAGE_DIR);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be the literal "skills"');
    expect(existsSync(join(CLI_PACKAGE_DIR, "src", "commands"))).toBe(true);
  });

  it("rejects a literal `skills` target from any other cwd, even one holding a package.json", () => {
    const foreignPackage = tempDir("first-tree-skill-target-cwd-");
    writeFileSync(join(foreignPackage, "package.json"), "{}\n");
    const fixture = plantSentinels(foreignPackage);

    const result = runCli(["--target", "skills", "--clean"], foreignPackage);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("may only run from");
    expectUnchanged(fixture);
  });
});

describe("withTrustedSkillsTarget construction", () => {
  it("derives the unique skills child of a trusted parent", () => {
    const parent = tempDir("first-tree-skill-target-ok-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(capability.targetSkillsRoot).toBe(join(realpathSync(parent), "skills"));
      expect(Object.isFrozen(capability)).toBe(true);
    });
  });

  it("rejects non-absolute and missing parents", () => {
    expectTransactionRejected({ trustedParentDir: "relative/dir" }, "absolute path");
    expectTransactionRejected(
      { trustedParentDir: join(tempDir("first-tree-skill-target-miss-"), "gone") },
      "missing or not a real directory",
    );
  });

  it("rejects a lexical parent containing a `..` segment instead of normalizing it away", () => {
    const parent = tempDir("first-tree-skill-target-lexical-");
    mkdirSync(join(parent, "sub"));
    const fixture = plantSentinels(parent);

    expectTransactionRejected({ trustedParentDir: `${parent}/sub/..` }, "canonical");
    expectUnchanged(fixture);
  });

  it.each([
    ["filesystem root", parse(process.cwd()).root],
    ["home directory", realpathSync(homedir())],
    ["repo root", realpathSync(SKILL_PAYLOAD_REPO_ROOT)],
    ["source skills root", realpathSync(join(SKILL_PAYLOAD_REPO_ROOT, "skills"))],
    ["source variants root", realpathSync(join(SKILL_PAYLOAD_REPO_ROOT, "skill-variants"))],
  ])("rejects the protected parent: %s", (_label, parent) => {
    expectTransactionRejected({ trustedParentDir: parent }, "protected");
  });

  it("rejects a First Tree workspace root as parent", () => {
    const workspace = tempDir("first-tree-skill-target-ws-");
    mkdirSync(join(workspace, ".first-tree-workspace"));
    const fixture = plantSentinels(workspace);

    expectTransactionRejected({ trustedParentDir: workspace }, "workspace root");
    expectUnchanged(fixture);
  });

  it("rejects an explicitly protected parent supplied by the caller", () => {
    const parent = tempDir("first-tree-skill-target-explicit-");
    const fixture = plantSentinels(parent);

    expectTransactionRejected({ trustedParentDir: parent, additionalProtectedParents: [parent] }, "protected");
    expectUnchanged(fixture);
  });

  it("rejects a symlink parent instead of canonicalizing it", () => {
    const real = tempDir("first-tree-skill-target-real-");
    const link = join(tempDir("first-tree-skill-target-link-"), "link");
    symlinkSync(real, link, "dir");
    const fixture = plantSentinels(real);

    expectTransactionRejected({ trustedParentDir: link }, "symlink component");
    expectUnchanged(fixture);
  });

  it("rejects a path beneath a symlink ancestor", () => {
    const real = tempDir("first-tree-skill-target-ancestor-");
    mkdirSync(join(real, "sub"));
    const link = join(tempDir("first-tree-skill-target-ancestor-link-"), "link");
    symlinkSync(real, link, "dir");
    const fixture = plantSentinels(join(real, "sub"));

    expectTransactionRejected({ trustedParentDir: join(link, "sub") }, "symlink component");
    expectUnchanged(fixture);
  });

  it("rejects an existing target that is a symlink", () => {
    const parent = tempDir("first-tree-skill-target-symlink-");
    const elsewhere = tempDir("first-tree-skill-target-elsewhere-");
    const fixture = plantSentinels(elsewhere);
    symlinkSync(join(elsewhere, "skills"), join(parent, "skills"), "dir");

    expectTransactionRejected({ trustedParentDir: parent }, "not a real directory");
    expectUnchanged(fixture);
  });
});

describe("capability-only copy entry points", () => {
  it("rejects a bare object shaped like a capability", () => {
    const parent = tempDir("first-tree-skill-target-bare-");
    const fixture = plantSentinels(parent);
    const bare = { targetSkillsRoot: join(realpathSync(parent), "skills"), canonicalParent: realpathSync(parent) };

    expect(() => copyPrivateSkillVariants({ target: bare })).toThrow("not a live capability");
    expect(() => copyAllSkillPayloads({ target: bare, clean: true })).toThrow("not a live capability");
    expect(() => resetSkillsTarget(bare)).toThrow("not a live capability");
    expectUnchanged(fixture);
  });

  it("rejects a copied or re-frozen clone of a real capability", () => {
    const parent = tempDir("first-tree-skill-target-clone-");
    const fixture = plantSentinels(parent);

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      const clone = Object.freeze({ ...capability });
      expect(() => copyAllSkillPayloads({ target: clone, clean: true })).toThrow("not a live capability");
      expect(() => resetSkillsTarget(clone)).toThrow("not a live capability");
    });
    expectUnchanged(fixture);
  });

  it("binds the source repo into the capability and rejects any repoRoot override, including a self-source swap", () => {
    const parent = tempDir("first-tree-skill-target-repo-swap-");
    const fixture = plantSentinels(parent);
    const swappedRepo = tempDir("first-tree-skill-target-repo-b-");
    mkdirSync(join(swappedRepo, "skills", "demo"), { recursive: true });

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      // Old call shapes that supply their own repoRoot must fail before the
      // first mutation — including the self-source case where the swapped repo
      // root is the trusted parent itself.
      expect(() => copyAllSkillPayloads({ repoRoot: swappedRepo, target: capability, clean: true })).toThrow(
        "repoRoot is bound",
      );
      expect(() => copyAllSkillPayloads({ repoRoot: parent, target: capability, clean: true })).toThrow(
        "repoRoot is bound",
      );
      expect(() => copyPrivateSkillVariants({ repoRoot: swappedRepo, target: capability })).toThrow(
        "repoRoot is bound",
      );
      expect(() => copyAllSkillPayloads({ repoRoot: capability.canonicalRepoRoot, target: capability })).toThrow(
        "repoRoot is bound",
      );
    });
    expectUnchanged(fixture);
    expect(existsSync(join(swappedRepo, "skills", "demo"))).toBe(true);
  });

  it("re-verifies before mutation and rejects a target swapped to a symlink after verification", () => {
    const parent = tempDir("first-tree-skill-target-toctou-");
    const elsewhere = tempDir("first-tree-skill-target-toctou-else-");
    const fixture = plantSentinels(elsewhere);
    mkdirSync(join(parent, "skills"));

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      rmSync(join(parent, "skills"), { recursive: true });
      symlinkSync(join(elsewhere, "skills"), join(parent, "skills"), "dir");

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow("no longer a real directory");
      expect(() => resetSkillsTarget(capability)).toThrow("no longer a real directory");
    });
    expectUnchanged(fixture);
  });

  it("rejects a capability whose parent is replaced by a symlink after verification", () => {
    const anchor = tempDir("first-tree-skill-target-anchor-");
    const parent = join(anchor, "parent");
    mkdirSync(parent);
    const fixture = plantSentinels(parent);
    const realElsewhere = tempDir("first-tree-skill-target-anchor-else-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      rmSync(parent, { recursive: true });
      symlinkSync(realElsewhere, parent, "dir");

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow();
      expect(existsSync(join(realElsewhere, "skills"))).toBe(false);
      expect(fixture.sentinelHash).toHaveLength(64); // fixture dir was removed with parent; nothing was recreated
      expect(existsSync(parent) && lstatSync(parent).isSymbolicLink()).toBe(true);
    });
  });

  it("rejects a capability whose parent is deleted and recreated as another real directory at the same path", () => {
    const anchor = tempDir("first-tree-skill-target-replace-");
    const parent = join(anchor, "parent");
    mkdirSync(parent);

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      // The open parent handle keeps the original inode alive, so the
      // replacement directory must receive a different identity even on
      // filesystems that aggressively recycle inodes.
      rmSync(parent, { recursive: true });
      mkdirSync(parent);
      const fixture = plantSentinels(parent);

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow("directory identity");
      expect(() => resetSkillsTarget(capability)).toThrow("directory identity");
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("directory identity");
      expectUnchanged(fixture);
    });
  });

  it("rejects a `.variants` symlink before any mutation in a variants-only copy", () => {
    const parent = tempDir("first-tree-skill-target-varsl-");
    const fixture = plantSentinels(parent);
    const external = tempDir("first-tree-skill-target-varsl-ext-");
    const externalFixture = plantSentinels(external);
    symlinkSync(join(external, "skills"), join(parent, "skills", ".variants"), "dir");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("not a real directory");
      expect(lstatSync(join(capability.targetSkillsRoot, ".variants")).isSymbolicLink()).toBe(true);
    });
    expectUnchanged(fixture);
    expectUnchanged(externalFixture);
  });

  it("rejects a `.variants` symlink before any public write in a full copy with clean:false", () => {
    const parent = tempDir("first-tree-skill-target-varsfull-");
    const fixture = plantSentinels(parent);
    const external = tempDir("first-tree-skill-target-varsfull-ext-");
    const externalFixture = plantSentinels(external);
    symlinkSync(join(external, "skills"), join(parent, "skills", ".variants"), "dir");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(() => copyAllSkillPayloads({ target: capability, clean: false })).toThrow("not a real directory");
      // No public skill payload was copied before the failure.
      expect(readdirSync(capability.targetSkillsRoot).sort()).toEqual([".variants", "sentinel.txt"].sort());
    });
    expectUnchanged(fixture);
    expectUnchanged(externalFixture);
  });

  it.skipIf(process.platform === "win32")("rejects a `.variants` special file before any mutation (POSIX FIFO)", () => {
    const parent = tempDir("first-tree-skill-target-varsfifo-");
    const fixture = plantSentinels(parent);
    const fifoPath = join(parent, "skills", ".variants");
    const mkfifo = spawnSync("mkfifo", [fifoPath]);
    expect(mkfifo.status).toBe(0);

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("not a real directory");
      expect(() => copyAllSkillPayloads({ target: capability, clean: false })).toThrow("not a real directory");
    });
    expectUnchanged(fixture);
    expect(lstatSync(fifoPath).isFIFO()).toBe(true);
  });

  it("rejects a `.variants` regular file before any mutation in a variants-only copy", () => {
    const parent = tempDir("first-tree-skill-target-varsfile-");
    const fixture = plantSentinels(parent);
    const filePath = join(parent, "skills", ".variants");
    writeFileSync(filePath, "not-a-directory");
    const fileHash = sha256(filePath);

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("not a real directory");
    });
    expect(sha256(filePath)).toBe(fileHash);
    expectUnchanged(fixture);
  });

  it("rejects a dangling symlink as the skills target at capability creation", () => {
    const parent = tempDir("first-tree-skill-target-dangling-");
    const link = join(parent, "skills");
    symlinkSync(join(parent, "nonexistent-destination"), link, "dir");

    expectTransactionRejected({ trustedParentDir: parent }, "not a real directory");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(parent, "nonexistent-destination"));
  });

  it("rejects a dangling symlink swapped in as the skills target after verification (copy and reset)", () => {
    const parent = tempDir("first-tree-skill-target-dangling-toctou-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      const link = capability.targetSkillsRoot;
      symlinkSync(join(parent, "nonexistent-destination"), link, "dir");

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow("no longer a real directory");
      expect(() => resetSkillsTarget(capability)).toThrow("no longer a real directory");
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("no longer a real directory");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(parent, "nonexistent-destination"));
    });
  });

  it("rejects a dangling symlink as `.variants` before any mutation (variants-only and full copy)", () => {
    const parent = tempDir("first-tree-skill-target-dangling-vars-");
    const fixture = plantSentinels(parent);
    const link = join(parent, "skills", ".variants");
    symlinkSync(join(parent, "nonexistent-destination"), link, "dir");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("not a real directory");
      expect(() => copyAllSkillPayloads({ target: capability, clean: false })).toThrow("not a real directory");
    });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(parent, "nonexistent-destination"));
    expectUnchanged(fixture);
  });
});

describe("source identity and containment", () => {
  it("rejects a target identical to the source repo root (repoRoot=P/skills, parent=P)", () => {
    const parent = tempDir("first-tree-skill-src-selfrepo-");
    const repo = join(parent, "skills");
    makeFakeRepo(repo);
    const sourceSentinel = join(repo, "skills", "demo-skill", "SKILL.md");
    const sourceHash = sha256(sourceSentinel);

    expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "equals or contains the source repo root");
    expect(sha256(sourceSentinel)).toBe(sourceHash);
  });

  it("rejects a target that contains the source repo root", () => {
    const parent = tempDir("first-tree-skill-src-contains-");
    const repo = join(parent, "skills", "repo");
    makeFakeRepo(repo);

    expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "equals or contains the source repo root");
    expect(existsSync(join(repo, "skills", "demo-skill", "SKILL.md"))).toBe(true);
  });

  it("treats a source repo whose first component starts with `..` as inside the target", () => {
    const parent = tempDir("first-tree-skill-src-dotdotname-");
    const repo = join(parent, "skills", "..repo");
    makeFakeRepo(repo);
    const sourceSentinel = join(repo, "skills", "demo-skill", "SKILL.md");
    const sourceHash = sha256(sourceSentinel);

    // relative(<P>/skills, <P>/skills/..repo) === "..repo": only a complete
    // `..` component means outside, so this must be rejected as containment.
    expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "equals or contains the source repo root");
    expect(sha256(sourceSentinel)).toBe(sourceHash);
  });

  it("rejects a repoRoot beneath a symlink ancestor instead of canonicalizing it", () => {
    const anchor = tempDir("first-tree-skill-src-anchor-");
    const real = join(anchor, "real");
    const repo = join(real, "repo");
    makeFakeRepo(repo);
    const sourceSentinel = join(repo, "skills", "demo-skill", "SKILL.md");
    const sourceHash = sha256(sourceSentinel);
    const linkBase = tempDir("first-tree-skill-src-linkbase-");
    symlinkSync(real, join(linkBase, "link"), "dir");

    expectTransactionRejected(
      {
        repoRoot: join(linkBase, "link", "repo"),
        trustedParentDir: tempDir("first-tree-skill-src-linkparent-"),
      },
      "symlink component",
    );
    expect(sha256(sourceSentinel)).toBe(sourceHash);
  });

  it.each([
    ["skills", join("skills", "nested")],
    ["variants", join("skill-variants", "nested")],
  ])("rejects a target beneath the source %s subtree", (_label, nestedParent) => {
    const repo = tempDir("first-tree-skill-src-subtree-");
    makeFakeRepo(repo);
    const parent = join(repo, nestedParent);
    mkdirSync(parent, { recursive: true });

    expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "overlapping a source directory");
    expect(existsSync(join(repo, "skills", "demo-skill", "SKILL.md"))).toBe(true);
  });

  it.each([
    ["repo root", (repo: string) => join(repo)],
    ["source skills root", (repo: string) => join(repo, "skills")],
    ["source variants root", (repo: string) => join(repo, "skill-variants")],
  ])("invalidates the capability when the %s is replaced by another real directory at the same path", (_label, pick) => {
    const repo = tempDir("first-tree-skill-src-replace-");
    makeFakeRepo(repo);
    const parent = tempDir("first-tree-skill-src-replace-parent-");

    withTrustedSkillsTarget({ repoRoot: repo, trustedParentDir: parent }, (capability) => {
      const victim = pick(repo);
      rmSync(victim, { recursive: true });
      if (victim === repo) {
        makeFakeRepo(repo);
      } else {
        mkdirSync(victim, { recursive: true });
      }
      const sentinel = join(victim, "recreated.txt");
      writeFileSync(sentinel, "recreated");
      const sentinelHash = sha256(sentinel);

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow(
        "no longer matches the verified identity",
      );
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("no longer matches the verified identity");
      expect(() => resetSkillsTarget(capability)).toThrow("no longer matches the verified identity");
      expect(sha256(sentinel)).toBe(sentinelHash);
      expect(existsSync(capability.targetSkillsRoot)).toBe(false);
    });
  });

  it("invalidates the capability when a source root is swapped to a live symlink pointing at the target", () => {
    const repo = tempDir("first-tree-skill-src-livelink-");
    makeFakeRepo(repo);
    const parent = tempDir("first-tree-skill-src-livelink-parent-");
    const fixture = plantSentinels(parent);

    withTrustedSkillsTarget({ repoRoot: repo, trustedParentDir: parent }, (capability) => {
      rmSync(join(repo, "skills"), { recursive: true });
      symlinkSync(capability.targetSkillsRoot, join(repo, "skills"), "dir");

      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow(
        "no longer matches the verified identity",
      );
      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("no longer matches the verified identity");
      expect(() => resetSkillsTarget(capability)).toThrow("no longer matches the verified identity");
    });
    expectUnchanged(fixture);
  });

  it("invalidates the capability when a source root is swapped to a dangling symlink", () => {
    const repo = tempDir("first-tree-skill-src-danglinglink-");
    makeFakeRepo(repo);
    const parent = tempDir("first-tree-skill-src-danglinglink-parent-");

    withTrustedSkillsTarget({ repoRoot: repo, trustedParentDir: parent }, (capability) => {
      rmSync(join(repo, "skill-variants"), { recursive: true });
      symlinkSync(join(repo, "nonexistent-destination"), join(repo, "skill-variants"), "dir");

      expect(() => copyPrivateSkillVariants({ target: capability })).toThrow("no longer matches the verified identity");
      expect(() => copyAllSkillPayloads({ target: capability, clean: true })).toThrow(
        "no longer matches the verified identity",
      );
      expect(lstatSync(join(repo, "skill-variants")).isSymbolicLink()).toBe(true);
      expect(existsSync(capability.targetSkillsRoot)).toBe(false);
    });
  });

  it("still allows the legitimate in-repo targets of the CLI and client bundle callers", () => {
    const repo = tempDir("first-tree-skill-src-legit-");
    makeFakeRepo(repo);
    mkdirSync(join(repo, "apps", "cli"), { recursive: true });
    mkdirSync(join(repo, "packages", "client"), { recursive: true });

    const cliResult = withTrustedSkillsTarget({ repoRoot: repo, trustedParentDir: join(repo, "apps", "cli") }, (cap) =>
      copyAllSkillPayloads({ target: cap, clean: true }),
    );
    expect(cliResult).toEqual({ publicCount: 1, variantCount: 2 });
    withTrustedSkillsTarget({ repoRoot: repo, trustedParentDir: join(repo, "packages", "client") }, (cap) => {
      resetSkillsTarget(cap);
      expect(copyPrivateSkillVariants({ target: cap })).toBe(2);
    });
    expect(existsSync(join(repo, "apps", "cli", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    expect(
      existsSync(
        join(repo, "packages", "client", "skills", ".variants", "local-context", "first-tree-read", "SKILL.md"),
      ),
    ).toBe(true);
  });
});

describe("transaction lifecycle", () => {
  it("returns the callback result and keeps sentinels intact", () => {
    const parent = tempDir("first-tree-skill-txn-return-");

    const result = withTrustedSkillsTarget({ trustedParentDir: parent }, () => "callback-value");

    expect(result).toBe("callback-value");
  });

  it("propagates a callback error and revokes the capability afterwards", () => {
    const parent = tempDir("first-tree-skill-txn-throw-");
    const fixture = plantSentinels(parent);
    let escaped: unknown;

    expect(() =>
      withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
        escaped = capability;
        throw new Error("callback boom");
      }),
    ).toThrow("callback boom");

    expect(() => copyAllSkillPayloads({ target: escaped, clean: true })).toThrow("not a live capability");
    expect(() => copyPrivateSkillVariants({ target: escaped })).toThrow("not a live capability");
    expect(() => resetSkillsTarget(escaped)).toThrow("not a live capability");
    expectUnchanged(fixture);
  });

  it("revokes the capability after a successful transaction too", () => {
    const parent = tempDir("first-tree-skill-txn-close-");
    const fixture = plantSentinels(parent);
    let escaped: unknown;

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      escaped = capability;
    });

    expect(() => copyAllSkillPayloads({ target: escaped, clean: true })).toThrow("not a live capability");
    expect(() => resetSkillsTarget(escaped)).toThrow("not a live capability");
    expectUnchanged(fixture);
  });

  it.each([
    undefined,
    null,
    false,
    0,
    "",
  ])("propagates a falsy thrown value (%s) exactly and still closes the transaction", (thrown) => {
    const parent = tempDir("first-tree-skill-txn-falsy-");
    const fixture = plantSentinels(parent);
    let escaped: unknown;
    let caught = false;
    let caughtValue: unknown;

    try {
      withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
        escaped = capability;
        // Deliberately rethrow the exact falsy value under test.
        throw thrown;
      });
    } catch (error) {
      caught = true;
      caughtValue = error;
    }

    expect(caught).toBe(true);
    expect(caughtValue).toBe(thrown);
    expect(() => copyAllSkillPayloads({ target: escaped, clean: true })).toThrow("not a live capability");
    expect(() => copyPrivateSkillVariants({ target: escaped })).toThrow("not a live capability");
    expect(() => resetSkillsTarget(escaped)).toThrow("not a live capability");
    expectUnchanged(fixture);
    // A fresh transaction completes, proving the guards were closed.
    const result = withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) =>
      copyAllSkillPayloads({ target: capability, clean: true }),
    );
    expect(result.variantCount).toBe(2);
  });

  it("never invokes the callback when construction fails midway (missing source variants root)", () => {
    const repo = tempDir("first-tree-skill-txn-midfail-");
    mkdirSync(join(repo, "skills", "demo-skill"), { recursive: true });
    const parent = tempDir("first-tree-skill-txn-midfail-parent-");
    const fixture = plantSentinels(parent);

    expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "not a real directory");
    expectUnchanged(fixture);
  });

  it("closes every handle across many successful and failing transactions (no FD leak)", () => {
    // A leaked handle per transaction would exhaust the process fd limit well
    // within these iterations (4 handles per success, 1-3 per mid failure).
    for (let index = 0; index < 300; index += 1) {
      const parent = tempDir("first-tree-skill-txn-fd-ok-");
      withTrustedSkillsTarget({ trustedParentDir: parent }, () => {});
    }
    for (let index = 0; index < 300; index += 1) {
      const repo = tempDir("first-tree-skill-txn-fd-fail-repo-");
      mkdirSync(join(repo, "skills", "demo-skill"), { recursive: true });
      const parent = tempDir("first-tree-skill-txn-fd-fail-parent-");
      expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "not a real directory");
    }
    // The process is still healthy: one more full copy succeeds afterwards.
    const parent = tempDir("first-tree-skill-txn-fd-final-");
    const copied = withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) =>
      copyAllSkillPayloads({ target: capability, clean: true }),
    );
    expect(copied.variantCount).toBe(2);
  });

  // EACCES on open only bites for non-root POSIX users; roots and Windows
  // do not exercise this partial-open failure path.
  it.skipIf(process.platform === "win32" || (typeof process.geteuid === "function" && process.geteuid() === 0))(
    "closes already-opened handles when a later source directory cannot be opened",
    () => {
      // Each iteration opens parent + repo + skills successfully, then fails
      // opening the chmod'd variants root: 100 × 3 leaked handles would hit
      // the fd limit if the partial-open path did not close in reverse.
      for (let index = 0; index < 100; index += 1) {
        const repo = tempDir("first-tree-skill-txn-partial-");
        makeFakeRepo(repo);
        chmodSync(join(repo, "skill-variants"), 0o000);
        const parent = tempDir("first-tree-skill-txn-partial-parent-");
        expectTransactionRejected({ repoRoot: repo, trustedParentDir: parent }, "EACCES");
        chmodSync(join(repo, "skill-variants"), 0o755);
      }
      const parent = tempDir("first-tree-skill-txn-partial-final-");
      withTrustedSkillsTarget({ trustedParentDir: parent }, () => {});
    },
  );

  it("rejects a thenable callback result after revoking the capability", () => {
    const parent = tempDir("first-tree-skill-txn-thenable-");
    const fixture = plantSentinels(parent);
    let escaped: unknown;

    expect(() =>
      withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
        escaped = capability;
        return Promise.resolve("not-supported");
      }),
    ).toThrow("synchronous");

    expect(() => copyAllSkillPayloads({ target: escaped, clean: true })).toThrow("not a live capability");
    expectUnchanged(fixture);
  });

  // Another process keeps deleting and recreating the trusted parent while
  // transactions open and verify guards: every transaction must either open
  // the exact verified object or fail closed at the plan/open/re-check
  // boundary — never authorize through a stale identity. (Copying into a
  // concurrently deleted target is out of scope: cpSync itself can abort on
  // that race, and the design's guarantee is the pre-mutation fail-closed
  // check, not copy atomicity.)
  it.skipIf(process.platform === "win32")(
    "stays fail-closed at the open boundary while another process swaps the parent directory",
    async () => {
      const parent = tempDir("first-tree-skill-txn-race-");
      const swapper = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
const path = require("node:path");
const parent = process.argv[1];
for (let i = 0; i < 5000; i += 1) {
  try {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.mkdirSync(parent, { recursive: true });
  } catch {}
}`,
          parent,
        ],
        { stdio: "ignore" },
      );
      // Register the exit promise up front: if the loop finishes on its own
      // before the finally block runs, the event has already been captured
      // and the await below cannot hang. Surface spawn errors the same way.
      const swapperExit = new Promise((resolve, reject) => {
        swapper.once("exit", resolve);
        swapper.once("error", reject);
      });
      try {
        const identityFailure =
          /no longer matches|changed between verification and open|missing or not a real directory|not a real directory/;
        const transientFsCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EINVAL", "EEXIST", "ENOTEMPTY"]);
        for (let index = 0; index < 200; index += 1) {
          try {
            withTrustedSkillsTarget({ trustedParentDir: parent }, () => {});
          } catch (error) {
            const message = String(error instanceof Error ? error.message : error);
            const code = (error as { code?: string })?.code;
            expect(identityFailure.test(message) || (code !== undefined && transientFsCodes.has(code))).toBe(true);
          }
        }
      } finally {
        if (swapper.exitCode === null && swapper.signalCode === null) {
          swapper.kill("SIGKILL");
        }
        await swapperExit;
      }
      // The swapper may have been killed between delete and recreate; restore
      // the parent, then a final full copy completes cleanly.
      mkdirSync(parent, { recursive: true });
      const result = withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) =>
        copyAllSkillPayloads({ target: capability, clean: true }),
      );
      expect(result.variantCount).toBe(2);
      expect(existsSync(join(parent, "skills", ".variants", "local-context", "first-tree-read", "SKILL.md"))).toBe(
        true,
      );
    },
  );
});

describe("verified copies", () => {
  it("copies public skills and private variants into a trusted temp target, idempotently across cleans", () => {
    const parent = tempDir("first-tree-skill-target-copy-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      const first = copyAllSkillPayloads({ target: capability, clean: true });
      writeFileSync(join(capability.targetSkillsRoot, "stale.txt"), "stale");
      const second = copyAllSkillPayloads({ target: capability, clean: true });

      expect(first.publicCount).toBeGreaterThan(0);
      expect(first.variantCount).toBe(2);
      expect(second).toEqual(first);
      expect(existsSync(join(capability.targetSkillsRoot, "stale.txt"))).toBe(false);
      const publicNames = readdirSync(capability.targetSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
      expect(publicNames.length).toBe(first.publicCount);
      expect(
        readdirSync(join(capability.targetSkillsRoot, ".variants", "local-context"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(["first-tree-read", "first-tree-write"]);
    });
  });

  it("copies hidden dot-directories verbatim but never counts them as public skills", () => {
    const parent = tempDir("first-tree-skill-target-hidden-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      const result = copyAllSkillPayloads({ target: capability, clean: true });
      const sourceNames = readdirSync(capability.sourceSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      const hidden = sourceNames.filter((name) => name.startsWith("."));
      // The count is exactly the non-hidden source directories, whatever the
      // repo currently carries — no hidden directory may inflate it.
      expect(result.publicCount).toBe(sourceNames.length - hidden.length);
      // Hidden directories still ride the verbatim copy (e.g. `.experimental`)
      // — excluded from the count, never from the payload.
      for (const name of hidden) {
        expect(existsSync(join(capability.targetSkillsRoot, name)), `hidden directory ${name} must be copied`).toBe(
          true,
        );
      }
    });
  });

  it("supports resetSkillsTarget plus a variants-only copy", () => {
    const parent = tempDir("first-tree-skill-target-variants-");

    withTrustedSkillsTarget({ trustedParentDir: parent }, (capability) => {
      resetSkillsTarget(capability);
      const copied = copyPrivateSkillVariants({ target: capability });

      expect(copied).toBe(2);
      expect(
        existsSync(join(capability.targetSkillsRoot, ".variants", "local-context", "first-tree-read", "SKILL.md")),
      ).toBe(true);
      expect(
        readdirSync(capability.targetSkillsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name),
      ).toEqual([]);
    });
  });
});
