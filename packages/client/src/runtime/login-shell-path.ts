import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Unique marker that brackets the canonical dir list in the probe output so we
 * can isolate it from any prompt / rc-file noise the interactive login shell
 * prints. Chosen to be vanishingly unlikely to appear in a real PATH entry.
 */
const DELIM = "__FT_SHELL_PATH__";

/**
 * Home-relative roots macOS puts behind a TCC "Files & Folders" consent prompt.
 *
 * The daemon runs this probe automatically at startup / reconnect, before the
 * user has chosen anything, so it must never be the reason macOS asks for
 * Desktop / Documents / Downloads / iCloud access. Both the shell script (which
 * would otherwise `cd` into every `$PATH` entry) and the parsed result (whose
 * dirs are later `existsSync`-checked by each provider resolver) skip these.
 *
 * The cost is bounded and deliberate: a provider binary whose `$PATH` entry
 * lives inside one of these roots is not auto-discovered. Every ordinary
 * install location — Homebrew, `~/.local/bin`, npm-global, pnpm, bun, and the
 * nvm / fnm / volta / mise / asdf shims this probe exists for — is unaffected.
 */
const MACOS_PROTECTED_HOME_SUBPATHS = [
  "Desktop",
  "Documents",
  "Downloads",
  // iCloud Drive, including the "Desktop & Documents Folders" sync target.
  "Library/Mobile Documents",
  // File Provider mounts: OneDrive, Dropbox, Google Drive, Box, …
  "Library/CloudStorage",
] as const;

/** Injectable seam for hermetic tests — returns the raw shell stdout, or null on failure. */
export type RunShell = () => string | null;

/**
 * Cap on the number of probe spawns per process. The first probe may run during
 * daemon startup under heavy load and time out; a transient failure must be
 * retryable so discovery is not permanently dead. But a persistently-failing
 * shell must not be re-spawned on every background poll, so after this many
 * unsuccessful attempts we settle to `[]` (cached) and stop probing.
 */
const MAX_ATTEMPTS = 3;

/** Cached result of a SUCCESSFUL probe — or the deterministic skip — kept for the process. */
let memo: { dirs: string[] } | undefined;
/** Count of probe spawns that did NOT succeed, used to enforce {@link MAX_ATTEMPTS}. */
let failedAttempts = 0;

/**
 * Discover the directories on the user's interactive **login-shell** PATH.
 *
 * The daemon runs under launchd/systemd with a PATH frozen at service-install
 * time that does NOT source the user's shell rc files (`.zshrc`, `.bash_profile`,
 * …). Node version managers (nvm / fnm / volta / mise / asdf), `~/.npm-global/bin`,
 * pnpm / bun global bins, and any custom `export PATH=` typically live ONLY on
 * that interactive PATH — so a `claude` / `codex` installed there is invisible to
 * the daemon's `env.PATH`. This probes the login shell and returns the extra
 * dirs so install-only capability detection can find those binaries.
 *
 * Each dir is **canonicalized inside the still-alive shell** (`cd "$d" && pwd -P`)
 * before being returned. fnm / nvm "multishell" PATH entries are per-session
 * symlink dirs (e.g. `/tmp/fnm_multishells/xxx/bin`) that are torn down when the
 * probe shell exits — by the time the caller `existsSync`-checks them they would
 * be gone. Resolving the symlink to the stable underlying install dir while the
 * shell lives hands back a path that still exists at search time.
 *
 * On macOS the shell canonicalizes only the per-session multishell dirs;
 * everything else is
 * canonicalized here by {@link resolveOutsideProtectedRoots}, which walks the
 * path with `readlink` so a dir that resolves into a TCC-protected root is
 * dropped WITHOUT ever being entered — see {@link MACOS_PROTECTED_HOME_SUBPATHS}.
 *
 * Properties:
 *   - **Memoized on success**: a probe that ran the shell, exited 0, and parsed a
 *     PATH is cached for the process — detection runs on a background poll, so we
 *     must never spawn a shell per probe once we have a real answer. The
 *     deterministic Windows / no-`$SHELL` skip is also cached immediately.
 *   - **Retries transient failure**: a spawn error, timeout, non-zero exit, or
 *     parse miss is NOT cached; a later call re-probes, up to {@link MAX_ATTEMPTS}
 *     spawns per process. After the cap is hit with no success, the result settles
 *     to `[]` (cached) so a persistently-failing shell is not re-spawned forever.
 *   - **Synchronous** (`spawnSync`): the resolvers that call this run synchronously
 *     at spawn time.
 *   - **Graceful**: returns `[]` on Windows, a non-zero/timed-out shell, missing
 *     stdout, or a parse miss — never throws.
 *
 * @param runShell test-only seam to supply the raw shell stdout without spawning.
 */
export function getLoginShellPathDirs(runShell: RunShell = defaultRunShell): string[] {
  if (memo) return memo.dirs;
  // Deterministic skip — cache immediately, this is not a transient failure.
  if (process.platform === "win32") {
    memo = { dirs: [] };
    return memo.dirs;
  }
  const dirs = probe(runShell);
  if (dirs) {
    const roots = protectedRootsOnThisHost();
    memo = {
      dirs:
        roots.length === 0
          ? dirs
          : dirs.map((dir) => resolveOutsideProtectedRoots(dir, roots)).filter((dir): dir is string => dir !== null),
    };
    return memo.dirs;
  }
  // Probe failed (spawn error / timeout / non-zero exit / parse miss). Don't
  // cache a transient failure — allow a later call to re-probe — but stop once
  // the per-process attempt cap is reached, settling to `[]`.
  failedAttempts += 1;
  if (failedAttempts >= MAX_ATTEMPTS) {
    memo = { dirs: [] };
    return memo.dirs;
  }
  return [];
}

/** Reset the memoized result and attempt counter. Tests only. */
export function resetLoginShellPathDirsCache(): void {
  memo = undefined;
  failedAttempts = 0;
}

/**
 * Run one probe. Returns the parsed PATH dirs on success (shell ran, exit 0, PATH
 * parsed — possibly an empty array if the parsed PATH had no usable dirs), or
 * `null` on any failure (spawn error / timeout / non-zero exit / missing stdout /
 * parse miss) so the caller can distinguish "ran ok" from "must retry".
 */
function probe(runShell: RunShell): string[] | null {
  let output: string | null;
  try {
    output = runShell();
  } catch {
    return null;
  }
  if (!output) return null;
  return parsePathFromShellOutput(output);
}

/**
 * Build the probe command the login shell launches: it prints, bracketed by
 * {@link DELIM}, the **canonicalized** dirs of `$PATH` — one per line. Exported
 * for tests.
 *
 * The probe must work no matter what the user's login shell is — including
 * **non-POSIX shells like fish / tcsh**, whose loop and quoting syntax differ
 * from `sh`. So the login shell is used only as a launcher: it runs a single
 * opaque `/bin/sh -c '…'` token (a literal, single-quoted string it never parses
 * as code), and ALL of the `$PATH` splitting and canonicalization happens inside
 * that nested POSIX `sh`. An earlier version inlined a POSIX `while … do … done`
 * pipeline directly in the login shell; fish parses the whole `-c` string as one
 * unit, hits the `do`/`done`, errors at parse time, and prints nothing — so every
 * login-shell-only `claude` / `codex` was reported missing.
 *
 * Inside the nested `sh`, `IFS=:; for d in $PATH` field-splits `$PATH` on `:`
 * (POSIX-defined here — unlike zsh, which would not field-split an unquoted
 * scalar), and each dir is canonicalized with `(cd "$d" && pwd -P)` **while the
 * login shell — and any per-session fnm/nvm multishell symlink — is still alive**.
 * Those multishell PATH entries (e.g. `/tmp/fnm_multishells/xxx/bin`) are torn
 * down when the login shell exits, so resolving them here, in-process, hands back
 * the stable underlying install dir that still exists at search time;
 * canonicalizing later in Node would find the symlink already gone. Dirs that
 * fail `cd` (gone / unreadable) are silently dropped — they could not hold a
 * spawnable binary anyway. The nested `sh` reads the login shell's exported
 * `$PATH`, which is colon-delimited regardless of how the outer shell stores it.
 * Verified end to end under bash, zsh, and sh; fish is covered by the
 * runtime-env-qa `DW7_fish_frozen` scenario.
 *
 * On macOS `cd` is NOT safe to run over arbitrary entries: `cd` resolves the
 * whole path, so an entry that is a symlink into a protected root — or that has
 * a symlinked ancestor — enters that root even though its spelling looks
 * harmless. A lexical guard alone cannot see through either. So on macOS the
 * shell canonicalizes ONLY the per-session multishell dirs that genuinely
 * require in-shell resolution ({@link multishellCasePatterns}); every other
 * entry is emitted verbatim, with no filesystem access at all, and
 * {@link getLoginShellPathDirs} resolves it with `readlink` instead — see
 * {@link resolveOutsideProtectedRoots}. `$HOME` is read
 * inside the shell rather than interpolated from Node so a home path containing
 * a quote can never break out of the `'…'` wrapper. On every other platform the
 * emitted script is byte-for-byte what it has always been.
 *
 * @param platform test seam / platform selector for the protected-root guard.
 */
export function buildProbeScript(platform: NodeJS.Platform = process.platform): string {
  // POSIX body run by the nested `sh`; uses only double quotes so the whole
  // string can be wrapped in single quotes for `/bin/sh -c '…'`. DELIM is a bare
  // word (letters + underscores), safe unquoted.
  const canonicalize = '(cd "$d" 2>/dev/null && pwd -P)';
  const body =
    platform === "darwin"
      ? `case "$d" in ${protectedCasePatterns()}) continue;; ${multishellCasePatterns()}) ${canonicalize};; ` +
        `*) printf "%s\\n" "$d";; esac`
      : canonicalize;
  const posix =
    `printf %s ${DELIM}; ` +
    `IFS=:; for d in $PATH; do [ -n "$d" ] || continue; ${body}; done; ` +
    `printf %s ${DELIM}`;
  return `/bin/sh -c '${posix}'`;
}

/**
 * `case` alternatives matching each protected root and everything beneath it.
 * Only double quotes are used so the result stays embeddable in `sh -c '…'`.
 */
function protectedCasePatterns(): string {
  return MACOS_PROTECTED_HOME_SUBPATHS.flatMap((sub) => {
    const root = `"$HOME"/${escapeCasePattern(sub)}`;
    return [root, `${root}/*`];
  }).join("|");
}

/**
 * `case` alternatives for the per-session multishell dirs — the ONLY entries
 * that must be canonicalized while the probe shell is alive, because their
 * symlink is torn down when it exits and Node could no longer follow it.
 *
 * Matched by the tool-specific directory name rather than by "somewhere under a
 * temp root". A temp root is not a safety guarantee: `$HOME` itself can sit
 * under one, and then a broad temp pattern would re-admit exactly the symlink
 * traversal this guard exists to close. These names are created by fnm / nvm,
 * never by a user pointing at their own folders.
 *
 * A per-session symlink dir from some other tool is not canonicalized in-shell
 * and will simply not resolve after the probe exits — the deliberate trade for
 * not entering paths we cannot vet first.
 */
function multishellCasePatterns(): string {
  return ["*/fnm_multishells/*", "*/nvm_multishells/*"].join("|");
}

/**
 * Escape a literal path fragment for use inside a `case` pattern: whitespace
 * would end the pattern word ("Library/Mobile Documents"), and glob
 * metacharacters would make it match more than the literal path.
 */
function escapeCasePattern(literal: string): string {
  return literal.replace(/[\s\\*?[\]]/gu, (char) => `\\${char}`);
}

/** This host's absolute TCC-protected roots. Empty off macOS, where none apply. */
function protectedRootsOnThisHost(): string[] {
  if (process.platform !== "darwin") return [];
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  return MACOS_PROTECTED_HOME_SUBPATHS.map((sub) => join(home, sub));
}

function insideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

/** Give up rather than loop forever on a symlink cycle. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Canonicalize `dir`, or return `null` if doing so would mean reaching into a
 * protected root.
 *
 * This exists because neither a lexical check nor `cd` can do the job alone. A
 * lexical check cannot see that `~/bin` is a symlink to `~/Documents/bin`, and
 * `cd` (or `realpath`, or `existsSync`) finds that out only by entering the
 * protected directory — which is the access we are trying to avoid, not a way
 * to detect it.
 *
 * So the path is walked one component at a time from the root. Each component
 * is checked against the protected roots BEFORE it is touched, and the only
 * syscall performed on it is `readlink`, which reads the link's own target and
 * never follows it. A component that is not a symlink is simply appended.
 * Because a symlink's target is re-walked from the root, an expansion that
 * lands in a protected root is caught on the next iteration, before anything
 * inside it is read — which covers the symlinked-ancestor case as well as a
 * symlinked entry.
 */
function resolveOutsideProtectedRoots(dir: string, roots: readonly string[]): string | null {
  let pending = resolve(dir).split(sep).filter(Boolean);
  let resolved: string = sep;
  let hops = 0;
  while (pending.length > 0) {
    const [head = "", ...rest] = pending;
    const candidate = join(resolved, head);
    if (insideAny(candidate, roots)) return null;
    let target: string | null = null;
    try {
      target = readlinkSync(candidate);
    } catch {
      // Not a symlink, missing, or unreadable — nothing to follow either way.
      // A missing dir stays in the result and simply fails the caller's
      // existence check, exactly as an uncanonicalized entry did before.
    }
    if (target === null) {
      resolved = candidate;
      pending = rest;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) return null;
    const expanded = isAbsolute(target) ? target : join(resolved, target);
    pending = [...resolve(expanded).split(sep).filter(Boolean), ...rest];
    resolved = sep;
  }
  return resolved;
}

/** Spawn the user's interactive login shell to run the probe; raw stdout or null. */
function defaultRunShell(): string | null {
  const shell = pickShell();
  const result = spawnSync(shell, ["-lic", buildProbeScript()], {
    encoding: "utf-8",
    timeout: 4_000,
    // SIGTERM (the spawnSync default) is ignored by a shell that traps it, spawns
    // a pager, or reads /dev/tty — which would hang this SYNC call (and the event
    // loop) past the timeout. SIGKILL cannot be trapped, so the timeout reliably
    // kills the probe.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return typeof result.stdout === "string" ? result.stdout : null;
}

function pickShell(): string {
  const shell = process.env.SHELL;
  if (shell && shell.length > 0) return shell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Extract the text between the two delimiters and split it into the canonical
 * dirs the shell printed (one per line). Returns `null` on a parse miss
 * (delimiters absent) so the caller treats it as a retryable failure rather than
 * a genuine empty PATH.
 */
function parsePathFromShellOutput(output: string): string[] | null {
  const start = output.indexOf(DELIM);
  if (start < 0) return null;
  const end = output.indexOf(DELIM, start + DELIM.length);
  if (end < 0) return null;
  const inner = output.slice(start + DELIM.length, end);
  return inner.split("\n").filter((dir) => dir.length > 0);
}
