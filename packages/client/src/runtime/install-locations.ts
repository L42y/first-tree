import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Injectable directory listing so tests need no real version-manager install. */
export type ReadDirNames = (path: string) => string[];

function listNames(path: string, readDir: ReadDirNames): string[] {
  try {
    return readDir(path);
  } catch {
    // No such version manager on this host, or the root is unreadable.
    return [];
  }
}

/** Newest-looking version first, so the chosen dir is stable across runs. */
const VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * `bin` dirs of every Node version installed by nvm or fnm.
 *
 * These are the STABLE homes of a `claude` / `codex` installed under a Node
 * version manager. The per-session dir such a shell actually puts on `$PATH`
 * (`fnm_multishells/<pid>_<ts>/bin`) is a symlink that disappears with the
 * shell, so it cannot be searched later — but its target lives here and does
 * not move. Enumerating these keeps version-manager installs discoverable
 * without following anything the user may have pointed somewhere unexpected.
 *
 * Every root read here belongs to the version manager itself, never to a
 * macOS TCC-protected folder, so this is safe to run during automatic probing.
 */
export function versionManagerBinDirs(home: string, readDir: ReadDirNames = readdirSync): string[] {
  const nvm = listNames(join(home, ".nvm", "versions", "node"), readDir)
    .sort((a, b) => VERSION_COLLATOR.compare(b, a))
    .map((version) => join(home, ".nvm", "versions", "node", version, "bin"));

  // fnm's data dir varies by installer: XDG default, Homebrew on macOS, and the
  // pre-XDG layout. `$FNM_DIR` wins when the operator set one.
  const fnmRoots = [
    process.env.FNM_DIR,
    join(home, ".local", "share", "fnm"),
    join(home, "Library", "Application Support", "fnm"),
    join(home, ".fnm"),
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  const seen = new Set<string>();
  const fnm = fnmRoots.flatMap((root) => {
    if (seen.has(root)) return [];
    seen.add(root);
    const versionsRoot = join(root, "node-versions");
    return listNames(versionsRoot, readDir)
      .sort((a, b) => VERSION_COLLATOR.compare(b, a))
      .map((version) => join(versionsRoot, version, "installation", "bin"));
  });

  return [...nvm, ...fnm];
}

/**
 * Curated, stable install directories where a globally-installed `claude` /
 * `codex` binary commonly lands but the daemon's frozen service PATH does not
 * include. Searched (cheaply, no spawn) after the daemon PATH and the
 * login-shell PATH, so capability detection still finds the binary even when the
 * login-shell probe is unavailable.
 *
 * Covers node-version-manager shims, global-npm prefixes, and the pnpm / bun
 * global bins. macOS-only Homebrew / pnpm dirs are gated on `darwin`. Returns
 * absolute dir paths (binary name is appended by the caller, per provider).
 *
 * The nvm / fnm version dirs come LAST, after every fixed location, so they
 * only decide the outcome when nothing else matched and the existing precedence
 * is untouched.
 */
export function wellKnownBinDirs(home: string, readDir?: ReadDirNames): string[] {
  const isMac = process.platform === "darwin";
  const dirs = [
    join(home, ".local", "bin"), // official native installer default
    join(home, ".claude", "local"), // `claude migrate-installer` target
    join(home, ".volta", "bin"), // volta
    join(home, ".asdf", "shims"), // asdf
    join(home, ".local", "share", "mise", "shims"), // mise
    join(home, ".npm-global", "bin"), // custom npm global prefix
    join(home, ".local", "share", "pnpm"), // pnpm global (linux/xdg)
    ...(isMac ? [join(home, "Library", "pnpm")] : []), // pnpm global (macOS)
    join(home, ".bun", "bin"), // bun global
    ...(isMac ? ["/opt/homebrew/bin"] : []), // Apple-silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / common manual installs
    ...versionManagerBinDirs(home, readDir),
  ];
  return dirs;
}

/**
 * macOS desktop-app resource directories that can carry the Codex CLI.
 *
 * Codex originally shipped as `/Applications/Codex.app`, then moved into the
 * ChatGPT desktop app. Keep the current name first and retain the standalone
 * app as a compatibility fallback. Per-user app installs use the same order.
 */
export function codexDesktopAppBinDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];

  return [
    join("/Applications", "ChatGPT.app", "Contents", "Resources"),
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources"),
    join("/Applications", "Codex.app", "Contents", "Resources"),
    join(home, "Applications", "Codex.app", "Contents", "Resources"),
  ];
}
