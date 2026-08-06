import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type ReadLink, resolveOutsideProtectedRootsOnThisHost } from "./protected-paths.js";

/** Injectable directory listing so tests need no real version-manager install. */
export type ReadDirNames = (path: string) => string[];

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
 */
export function wellKnownBinDirs(home: string): string[] {
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
  ];
  return dirs;
}

/** Injectable seams so tests need neither a real install nor a real filesystem. */
export type VersionManagerDirDeps = {
  readDir?: ReadDirNames;
  readLink?: ReadLink;
  env?: NodeJS.ProcessEnv;
};

/**
 * `bin` dirs of every Node version installed by nvm or fnm, **newest first**.
 *
 * These are the STABLE homes of a `claude` / `codex` installed under a Node
 * version manager. The dir such a shell actually puts on `$PATH`
 * (`fnm_multishells/<pid>_<ts>/bin`) is a per-session symlink that disappears
 * with the shell, so it cannot be searched afterwards — but its target lives
 * here and does not move.
 *
 * This is a FALLBACK, not a preference: callers must search it only after the
 * login-shell dirs, so a shell that intentionally selected an older version
 * keeps that version (and its credential context) whenever the live dir is
 * still resolvable. Newest-first only decides between versions once the active
 * one is already gone.
 *
 * Every root and every returned dir is vetted with
 * {@link resolveOutsideProtectedRootsOnThisHost} BEFORE it is listed or handed
 * back. Nothing here is trusted for being spelled like a version manager:
 * `$FNM_DIR` is user-controlled, and `~/.nvm`, a fnm data dir, or a single
 * version entry can each be a symlink — or sit under one — pointing into a
 * protected folder.
 */
export function versionManagerBinDirs(home: string, deps: VersionManagerDirDeps = {}): string[] {
  const readDir = deps.readDir ?? readdirSync;
  const readLink = deps.readLink;
  const env = deps.env ?? process.env;

  const safe = (path: string): string | null => resolveOutsideProtectedRootsOnThisHost(path, readLink);

  /** List `root`'s entries only once the root itself is known to be safe. */
  const versionsUnder = (root: string): Array<{ version: string; root: string }> => {
    const vetted = safe(root);
    if (vetted === null) return [];
    try {
      return readDir(vetted)
        .sort((a, b) => VERSION_COLLATOR.compare(b, a))
        .map((version) => ({ version, root: vetted }));
    } catch {
      // No such version manager on this host, or the root is unreadable.
      return [];
    }
  };

  const nvm = versionsUnder(join(home, ".nvm", "versions", "node")).map(({ version, root }) =>
    join(root, version, "bin"),
  );

  // fnm's data dir varies by installer: XDG default, Homebrew on macOS, and the
  // pre-XDG layout. `$FNM_DIR` wins when the operator set one — and is exactly
  // why the vetting above is not optional.
  const fnmRoots = [
    env.FNM_DIR,
    join(home, ".local", "share", "fnm"),
    join(home, "Library", "Application Support", "fnm"),
    join(home, ".fnm"),
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  const seen = new Set<string>();
  const fnm = fnmRoots.flatMap((root) => {
    if (seen.has(root)) return [];
    seen.add(root);
    return versionsUnder(join(root, "node-versions")).map(({ version, root: versionsRoot }) =>
      join(versionsRoot, version, "installation", "bin"),
    );
  });

  // A vetted root can still hold a version entry that is itself a symlink into a
  // protected folder, so re-vet each candidate before returning it.
  return [...nvm, ...fnm].map(safe).filter((dir): dir is string => dir !== null);
}

/** Newest-looking version first, so the chosen dir is stable across runs. */
const VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

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
