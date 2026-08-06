import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProbeScript,
  getLoginShellPathDirs,
  type RunShell,
  resetLoginShellPathDirsCache,
} from "../runtime/login-shell-path.js";

const DELIM = "__FT_SHELL_PATH__";

/** Extract the delimited dir list from raw probe stdout. */
function parseDirs(stdout: string): string[] {
  const start = stdout.indexOf(DELIM);
  const end = stdout.indexOf(DELIM, start + DELIM.length);
  return stdout
    .slice(start + DELIM.length, end)
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Simulate the probe stdout: the canonical dirs the login shell prints (one per
 * line) bracketed by {@link DELIM}, preceded by some rc-file prompt noise.
 */
function wrap(dirs: string[]): string {
  return `some prompt noise\n${DELIM}${dirs.join("\n")}${DELIM}\n`;
}

describe("getLoginShellPathDirs", () => {
  // Pin a non-macOS baseline so the parsing tests never depend on the host: on
  // macOS the result goes through protected-root resolution, which follows real
  // symlinks (`/home` is a firmlink there) and would rewrite synthetic paths.
  // The macOS tests opt in explicitly.
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    resetLoginShellPathDirsCache();
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  it("parses the delimited canonical dirs from shell output, dropping empty lines", () => {
    const dirs = getLoginShellPathDirs(() => wrap(["/home/u/.nvm/v/bin", "", "/usr/local/bin", ""]));
    expect(dirs).toEqual(["/home/u/.nvm/v/bin", "/usr/local/bin"]);
  });

  it("returns [] when the shell output is null (probe failure)", () => {
    expect(getLoginShellPathDirs(() => null)).toEqual([]);
  });

  it("returns [] when the delimiters are missing (parse miss)", () => {
    expect(getLoginShellPathDirs(() => "no markers here")).toEqual([]);
  });

  it("treats a successfully-parsed empty PATH as success (cached, no retry)", () => {
    const runShell = vi.fn(() => wrap([]));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("returns [] on win32 without invoking the shell", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const runShell = vi.fn(() => wrap(["/should/not/be/used"]));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("does not throw when the shell seam throws", () => {
    expect(() =>
      getLoginShellPathDirs(() => {
        throw new Error("spawn failed");
      }),
    ).not.toThrow();
    expect(
      getLoginShellPathDirs(() => {
        throw new Error("spawn failed");
      }),
    ).toEqual([]);
  });

  it("memoizes a successful probe: the shell seam runs once across calls", () => {
    const runShell = vi.fn(() => wrap(["/a/bin"]));
    const first = getLoginShellPathDirs(runShell);
    const second = getLoginShellPathDirs(runShell);
    const third = getLoginShellPathDirs(runShell);
    expect(first).toEqual(["/a/bin"]);
    expect(second).toEqual(["/a/bin"]);
    expect(third).toEqual(["/a/bin"]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("re-probes a failing shell (null) up to the cap, then settles to [] cached", () => {
    const runShell = vi.fn(() => null);
    // First two calls fail and re-probe; the third hits MAX_ATTEMPTS and caches [].
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
    // Subsequent calls are served from cache — no further spawns past the cap.
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
  });

  it("re-probes a throwing shell up to the cap, then settles to [] cached", () => {
    const runShell = vi.fn(() => {
      throw new Error("spawn failed");
    });
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
  });

  it("recovers: a success after transient failures caches and stops retrying", () => {
    const runShell = vi
      .fn<RunShell>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(wrap(["/late/bin"]))
      .mockReturnValue(wrap(["/unused/bin"]));
    // First call fails (re-probable), second succeeds and caches.
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual(["/late/bin"]);
    expect(getLoginShellPathDirs(runShell)).toEqual(["/late/bin"]);
    expect(runShell).toHaveBeenCalledTimes(2);
  });

  it("does not spawn on win32 even on repeated calls", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const runShell = vi.fn(() => wrap(["/should/not/be/used"]));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("drops macOS TCC-protected dirs from a successful probe", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", "/Users/tester");
    const dirs = getLoginShellPathDirs(() =>
      wrap([
        "/opt/homebrew/bin",
        "/Users/tester/Documents/bin",
        "/Users/tester/Desktop",
        "/Users/tester/Downloads/tools/bin",
        "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/bin",
        "/Users/tester/Library/CloudStorage/OneDrive/bin",
        "/Users/tester/.nvm/versions/node/v22.0.0/bin",
        // Not protected: a sibling whose name merely starts with a protected one.
        "/Users/tester/Documents-archive/bin",
      ]),
    );
    expect(dirs).toEqual([
      "/opt/homebrew/bin",
      "/Users/tester/.nvm/versions/node/v22.0.0/bin",
      "/Users/tester/Documents-archive/bin",
    ]);
  });

  // The spelling of a `$PATH` entry says nothing about where it lands: `~/bin`
  // can be a symlink to `~/Documents/bin`, and `~/deep/mid/bin` can reach the
  // same place through a symlinked ANCESTOR. Resolution therefore has to reject
  // these without entering them — `readlink` reads the link itself, `cd` /
  // `realpath` / `existsSync` would already be the protected access.
  it.skipIf(process.platform === "win32")("rejects symlinks into a protected root without entering them", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-symlink-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    mkdirSync(join(home, "safe", "bin"), { recursive: true });
    // `~/bin` -> `~/Documents/real`, so `~/bin/bin` is a protected target.
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    // `~/deep/mid` -> `~/Documents`, so the protected root is an ANCESTOR.
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    // A symlink that stays outside must still resolve, and to its target.
    symlinkSync(join(home, "safe", "bin"), join(home, "safe-link"));

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    const dirs = getLoginShellPathDirs(() =>
      wrap([join(home, "bin", "bin"), join(home, "deep", "mid", "real", "bin"), join(home, "safe-link")]),
    );

    expect(dirs).toEqual([join(home, "safe", "bin")]);
  });

  it.skipIf(process.platform === "win32")("does not loop forever on a symlink cycle", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-cycle-")));
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", root);
    expect(getLoginShellPathDirs(() => wrap([join(root, "a")]))).toEqual([]);
  });

  it("keeps protected-looking dirs on non-macOS hosts", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("HOME", "/home/tester");
    expect(getLoginShellPathDirs(() => wrap(["/home/tester/Documents/bin", "/usr/local/bin"]))).toEqual([
      "/home/tester/Documents/bin",
      "/usr/local/bin",
    ]);
  });
});

/**
 * Integration coverage for the real probe script. The login shell launches it as
 * a single opaque `/bin/sh -c '…'` token, so it must run identically no matter
 * what that outer shell is — that shell-agnostic launcher shape is exactly what
 * lets fish / tcsh (which cannot parse a POSIX `do … done` loop) work. We cannot
 * assume fish is installed in CI, so this exercises the mechanism through
 * `/bin/sh` as the outer launcher (and the platform default via the real
 * `defaultRunShell`); fish itself is covered by the runtime-env-qa
 * `DW7_fish_frozen` scenario.
 *
 * The outer launcher is invoked with `-c` only — NOT the production `-lic`. The
 * `-l`/`-i` flags exist solely to source the user's rc files, which this test
 * does not need, and they are not portable: on Ubuntu CI `/bin/sh` is `dash`,
 * whose `-l` support varies. `-c` is universally supported, and the nested
 * `for`/`cd`/`pwd -P` loop runs identically under dash, so this stays green on
 * every POSIX `/bin/sh`.
 */
describe("probe script (real execution)", () => {
  afterEach(() => resetLoginShellPathDirsCache());

  it.skipIf(process.platform === "win32")(
    "runs the opaque nested /bin/sh command under a POSIX shell and yields canonical, absolute PATH dirs",
    () => {
      const r = spawnSync("/bin/sh", ["-c", buildProbeScript()], {
        encoding: "utf-8",
        timeout: 4_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Surface a launcher failure explicitly instead of as an opaque empty result.
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      const dirs = getLoginShellPathDirs(() => (typeof r.stdout === "string" ? r.stdout : null));
      // A real environment always has at least one PATH dir, and every dir the
      // probe returns is canonicalized (`pwd -P`) so it must be absolute.
      expect(dirs.length).toBeGreaterThan(0);
      for (const dir of dirs) expect(dir.startsWith("/")).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("the real default-shell probe returns absolute dirs without throwing", () => {
    const dirs = getLoginShellPathDirs();
    expect(Array.isArray(dirs)).toBe(true);
    for (const dir of dirs) expect(dir.startsWith("/")).toBe(true);
  });

  // End-to-end over the real shell AND the real parse: a `$PATH` whose entries
  // reach a protected root by spelling, by symlinked entry, and by symlinked
  // ANCESTOR must produce no protected dir — while the fnm / nvm multishell
  // case (a symlink under a temp root) still gets canonicalized in-shell,
  // because that symlink is gone by the time the parse runs.
  it.skipIf(process.platform === "win32")("never yields a protected dir, however the entry reaches one", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-probe-")));
    const home = join(root, "home");
    const multishellTarget = join(root, "fnm-install", "bin");
    // The real fnm shape: a per-session symlink under a `fnm_multishells` dir.
    const multishellLink = join(root, "fnm_multishells", "1234_567", "bin");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    mkdirSync(multishellTarget, { recursive: true });
    mkdirSync(join(root, "fnm_multishells", "1234_567"), { recursive: true });
    // Lexically innocent, resolves into Documents: as the entry, and via ancestor.
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    // The multishell shape: a symlink under a temp root, torn down with the shell.
    symlinkSync(multishellTarget, multishellLink);

    const protectedEntries = [
      join(home, "Documents", "bin"),
      join(home, "bin", "bin"),
      join(home, "deep", "mid", "real", "bin"),
    ];
    const r = spawnSync("/bin/sh", ["-c", buildProbeScript("darwin")], {
      encoding: "utf-8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PATH: [...protectedEntries, join(root, "tools", "bin"), multishellLink].join(":"),
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);

    // The shell never entered any of them: had `cd` resolved one, its RESOLVED
    // path would be here, and every resolved path passes through Documents.
    const raw = parseDirs(typeof r.stdout === "string" ? r.stdout : "");
    expect(raw.filter((dir) => dir.includes(`${sep}Documents${sep}`))).toEqual([]);
    // The multishell entry is canonicalized while its symlink is still alive.
    expect(raw).toContain(multishellTarget);
    expect(raw).not.toContain(multishellLink);

    // And the parse drops the ones the shell could only pass through verbatim.
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    const dirs = getLoginShellPathDirs(() => (typeof r.stdout === "string" ? r.stdout : null));
    for (const entry of protectedEntries) expect(dirs).not.toContain(entry);
    expect(dirs.filter((dir) => dir.includes(`${sep}Documents${sep}`))).toEqual([]);
    expect(dirs).toContain(join(root, "tools", "bin"));
    expect(dirs).toContain(multishellTarget);
  });

  it("emits the unguarded script on non-macOS platforms", () => {
    const linux = buildProbeScript("linux");
    expect(linux).not.toContain("case ");
    expect(linux).not.toContain("$HOME");
    expect(buildProbeScript("win32")).toBe(linux);
  });
});
