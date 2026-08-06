import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCodexExecutableOnPath } from "../runtime/codex-binary.js";
import { versionManagerBinDirs, wellKnownBinDirs } from "../runtime/install-locations.js";

describe("versionManagerBinDirs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists nvm and fnm version bins, newest version first", () => {
    const home = "/home/u";
    const readDir = (path: string): string[] => {
      if (path === join(home, ".nvm", "versions", "node")) return ["v20.11.0", "v22.2.0", "v9.0.0"];
      if (path === join(home, ".local", "share", "fnm", "node-versions")) return ["v18.0.0", "v22.2.0"];
      throw new Error("ENOENT");
    };

    expect(versionManagerBinDirs(home, readDir)).toEqual([
      // Numeric-aware, so v22 sorts above v9 rather than below it.
      join(home, ".nvm", "versions", "node", "v22.2.0", "bin"),
      join(home, ".nvm", "versions", "node", "v20.11.0", "bin"),
      join(home, ".nvm", "versions", "node", "v9.0.0", "bin"),
      join(home, ".local", "share", "fnm", "node-versions", "v22.2.0", "installation", "bin"),
      join(home, ".local", "share", "fnm", "node-versions", "v18.0.0", "installation", "bin"),
    ]);
  });

  it("covers the Homebrew and pre-XDG fnm layouts and honours $FNM_DIR", () => {
    const home = "/home/u";
    vi.stubEnv("FNM_DIR", "/opt/fnm");
    const readDir = (path: string): string[] => {
      if (path === join("/opt/fnm", "node-versions")) return ["v22.0.0"];
      if (path === join(home, "Library", "Application Support", "fnm", "node-versions")) return ["v21.0.0"];
      if (path === join(home, ".fnm", "node-versions")) return ["v20.0.0"];
      throw new Error("ENOENT");
    };

    expect(versionManagerBinDirs(home, readDir)).toEqual([
      join("/opt/fnm", "node-versions", "v22.0.0", "installation", "bin"),
      join(home, "Library", "Application Support", "fnm", "node-versions", "v21.0.0", "installation", "bin"),
      join(home, ".fnm", "node-versions", "v20.0.0", "installation", "bin"),
    ]);
  });

  it("returns nothing when no version manager is installed", () => {
    expect(
      versionManagerBinDirs("/home/u", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });

  it("appends version dirs after every fixed location, leaving precedence intact", () => {
    const home = "/home/u";
    const fixed = wellKnownBinDirs(home, () => {
      throw new Error("ENOENT");
    });
    const withVersions = wellKnownBinDirs(home, (path) =>
      path === join(home, ".nvm", "versions", "node") ? ["v22.0.0"] : [],
    );

    expect(withVersions.slice(0, fixed.length)).toEqual(fixed);
    expect(withVersions).toContain(join(home, ".nvm", "versions", "node", "v22.0.0", "bin"));
  });
});

describe("version-manager discovery after a multishell teardown", () => {
  // The exact regression #1314 fixed, re-checked against the mechanism that
  // replaced it. fnm puts a per-session SYMLINK on `$PATH`; it is gone once the
  // probe shell exits, so nothing can follow it afterwards. The binary itself
  // never moved — it lives in the stable version dir — and that is what must
  // keep the provider discoverable.
  it("still finds a codex installed under fnm once the session symlink is gone", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-fnm-")));
    const home = join(root, "home");
    const installBin = join(home, ".local", "share", "fnm", "node-versions", "v22.2.0", "installation", "bin");
    const multishell = join(root, "fnm_multishells", "4321_9");
    mkdirSync(installBin, { recursive: true });
    mkdirSync(join(root, "fnm_multishells"), { recursive: true });
    const codex = join(installBin, "codex");
    writeFileSync(codex, "#!/bin/sh\n");
    chmodSync(codex, 0o755);
    symlinkSync(installBin, multishell);

    // The login-shell seam models the probe shell's lifetime: by the time it has
    // answered, its per-session dir no longer exists.
    const loginShellPathDirs = (): string[] => {
      rmSync(multishell, { force: true });
      return [multishell];
    };

    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "linux",
          pathDelimiter: ":",
          loginShellPathDirs,
          // Only the version dirs, so a real binary on this host's `/usr/local`
          // or Homebrew path cannot answer for the mechanism under test. That
          // `wellKnownBinDirs` appends these is covered above.
          wellKnownDirs: () => versionManagerBinDirs(home),
          desktopAppDirs: () => [],
        },
      ),
    ).toBe(codex);
  });
});
