import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";
import { portableShimContents, resolvePortableInstallContext } from "../core/portable-install-context.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ft-portable-context-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("portable install context", () => {
  it("ignores a real stale global-first PATH and preserves the stable custom shim", () => {
    const home = tempRoot();
    const prefix = join(home, "portable");
    const root = join(prefix, "current");
    const binDir = join(home, "custom-bin");
    const legacyBinDir = join(home, "legacy-global-bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(legacyBinDir, { recursive: true });
    writeFileSync(join(binDir, channelConfig.binName), portableShimContents(root, binDir), { mode: 0o755 });
    writeFileSync(join(legacyBinDir, channelConfig.binName), "#!/bin/sh\necho stale-global\n", { mode: 0o755 });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${legacyBinDir}${delimiter}${binDir}`);
    vi.stubEnv("FIRST_TREE_INSTALL_MODE", "portable");
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", root);
    vi.stubEnv("FIRST_TREE_PORTABLE_BIN_DIR", binDir);

    expect(resolvePortableInstallContext()).toEqual({
      root,
      prefix,
      binDir,
      cliPath: join(binDir, channelConfig.binName),
      nodeBinDir: join(root, "node", "bin"),
    });
  });

  it("refuses incomplete or ambiguous portable identity instead of scanning PATH", () => {
    const home = tempRoot();
    const prefix = join(home, "portable");
    const root = join(prefix, "current");
    const customBin = join(home, "old-custom-bin");
    mkdirSync(customBin, { recursive: true });
    writeFileSync(
      join(customBin, channelConfig.binName),
      `#!/bin/sh\nroot="${root}"\nexport FIRST_TREE_INSTALL_MODE=portable\nexport FIRST_TREE_PORTABLE_ROOT="$root"\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", customBin);
    vi.stubEnv("FIRST_TREE_INSTALL_MODE", "portable");
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", root);
    vi.stubEnv("FIRST_TREE_PORTABLE_BIN_DIR", "");

    expect(() => resolvePortableInstallContext()).toThrow("Rerun the");

    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", "relative/current");
    expect(() => resolvePortableInstallContext()).toThrow("must be absolute");

    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", "");
    expect(() => resolvePortableInstallContext()).toThrow("missing FIRST_TREE_PORTABLE_ROOT");
  });
});
