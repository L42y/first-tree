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
 * Injectable seam for the ONE syscall path resolution is allowed to make. Tests
 * use it to assert what was touched, which is the property that matters here:
 * a reviewer can check the ordering by reading the code, but only this can show
 * that no protected path was ever passed to it.
 */
export type ReadLink = (path: string) => string;

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
 * Off macOS each dir is **canonicalized inside the still-alive shell**
 * (`cd "$d" && pwd -P`). fnm / nvm "multishell" PATH entries are per-session
 * symlink dirs (e.g. `/tmp/fnm_multishells/xxx/bin`) that are torn down when the
 * probe shell exits — by the time the caller `existsSync`-checks them they would
 * be gone. Resolving the symlink to the stable underlying install dir while the
 * shell lives hands back a path that still exists at search time.
 *
 * On macOS the shell does no filesystem access at all and the same
 * canonicalization happens here, via {@link resolveOutsideProtectedRoots}: it
 * walks each path with `readlink`, so a dir that resolves into a TCC-protected
 * root is dropped WITHOUT ever being entered — see
 * {@link MACOS_PROTECTED_HOME_SUBPATHS}. That runs immediately after the probe
 * returns, so a multishell dir still present then resolves exactly as before;
 * one already torn down does not. Relative `$PATH` entries also resolve against
 * this process's cwd rather than the probe shell's, which only matters for a
 * shape that cannot hold a reliably spawnable binary anyway.
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
 * @param readLink test-only seam to observe every path resolution touches.
 */
export function getLoginShellPathDirs(
  runShell: RunShell = defaultRunShell,
  readLink: ReadLink = readlinkSync,
): string[] {
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
          : dirs
              .map((dir) => resolveOutsideProtectedRoots(dir, roots, readLink))
              .filter((dir): dir is string => dir !== null),
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
 * On macOS this script performs **no filesystem access at all**: it only prints
 * `$PATH`, one entry per line, and {@link getLoginShellPathDirs} does the
 * resolving. `cd` resolves a whole path at once, so it enters a protected root
 * whenever an entry is a symlink into one or has a symlinked ancestor — and no
 * lexical test on the spelling can predict that. Carving out "safe" spellings
 * was tried twice (a temp-root prefix, then the fnm/nvm multishell directory
 * name) and neither is a boundary: `$HOME` can live under a temp root, and a
 * multishell-named link can point at Documents. Emitting the raw entries makes
 * the guarantee structural rather than argued, and leaves it in one place that
 * unit tests can reach: {@link resolveOutsideProtectedRoots}.
 *
 * The cost is that a per-session symlink dir already torn down by the time the
 * probe returns can no longer be followed. On every other platform the emitted
 * script is byte-for-byte what it has always been.
 *
 * @param platform test seam / platform selector for the macOS behavior.
 */
export function buildProbeScript(platform: NodeJS.Platform = process.platform): string {
  // POSIX body run by the nested `sh`; uses only double quotes so the whole
  // string can be wrapped in single quotes for `/bin/sh -c '…'`. DELIM is a bare
  // word (letters + underscores), safe unquoted.
  //
  // `set -f` is load-bearing, not hygiene. Unquoted `$PATH` undergoes field
  // splitting AND pathname expansion, so an entry spelled `$HOME/Documents/*`
  // makes the shell ENUMERATE that directory — reading a protected folder and
  // pulling its entry names into the result — before any of the code below
  // runs. Disabling globbing keeps the split while leaving each entry literal.
  const body = platform === "darwin" ? 'printf "%s\\n" "$d"' : '(cd "$d" 2>/dev/null && pwd -P)';
  const posix =
    `printf %s ${DELIM}; ` +
    `set -f; IFS=:; for d in $PATH; do [ -n "$d" ] || continue; ${body}; done; ` +
    `printf %s ${DELIM}`;
  return `/bin/sh -c '${posix}'`;
}

/** This host's absolute TCC-protected roots. Empty off macOS, where none apply. */
function protectedRootsOnThisHost(): string[] {
  if (process.platform !== "darwin") return [];
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  return MACOS_PROTECTED_HOME_SUBPATHS.map((sub) => join(home, sub));
}

/**
 * Case-fold for path comparison. The default macOS filesystem is
 * case-INSENSITIVE, so `~/documents/bin` and `~/Documents/bin` are the same
 * directory and a case-sensitive guard would wave one of them through. Folding
 * both sides is also the conservative answer on a case-sensitive volume, where
 * it can only over-reject — never enter a protected folder by accident.
 */
function fold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function insideAny(path: string, roots: readonly string[]): boolean {
  const candidate = fold(path);
  return roots.some((root) => {
    const folded = fold(root);
    return candidate === folded || candidate.startsWith(`${folded}${sep}`);
  });
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
function resolveOutsideProtectedRoots(dir: string, roots: readonly string[], readLink: ReadLink): string | null {
  let pending = resolve(dir).split(sep).filter(Boolean);
  let resolved: string = sep;
  let hops = 0;
  while (pending.length > 0) {
    const [head = "", ...rest] = pending;
    const candidate = join(resolved, head);
    if (insideAny(candidate, roots)) return null;
    let target: string | null = null;
    try {
      target = readLink(candidate);
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
