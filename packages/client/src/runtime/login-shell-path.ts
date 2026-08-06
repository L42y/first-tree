import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { versionManagerBinDirs } from "./install-locations.js";
import { protectedRootsOnThisHost, type ReadLink, resolveOutsideProtectedRoots } from "./protected-paths.js";

/**
 * Unique marker that brackets the canonical dir list in the probe output so we
 * can isolate it from any prompt / rc-file noise the interactive login shell
 * prints. Chosen to be vanishingly unlikely to appear in a real PATH entry.
 */
const DELIM = "__FT_SHELL_PATH__";

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
 * root is dropped WITHOUT ever being entered. That runs immediately after the
 * probe returns, so a multishell dir still present then resolves exactly as
 * before; one already torn down does not. Relative `$PATH` entries also resolve
 * against this process's cwd rather than the probe shell's, which only matters
 * for a shape that cannot hold a reliably spawnable binary anyway.
 *
 * The nvm / fnm stable version dirs are appended AFTER whatever the probe
 * returned, so a torn-down multishell entry still has somewhere to resolve from
 * while an intentionally selected version — which the live probe reports first —
 * keeps winning. Callers search this list in order, so the fallback only decides
 * the outcome once the active dir is gone.
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
export function getLoginShellPathDirs(runShell: RunShell = defaultRunShell, readLink?: ReadLink): string[] {
  if (memo) return memo.dirs;
  // Deterministic skip — cache immediately, this is not a transient failure.
  if (process.platform === "win32") {
    memo = { dirs: [] };
    return memo.dirs;
  }
  const dirs = probe(runShell);
  if (dirs) {
    const roots = protectedRootsOnThisHost();
    const live =
      roots.length === 0
        ? dirs
        : dirs
            .map((dir) => resolveOutsideProtectedRoots(dir, roots, readLink))
            .filter((dir): dir is string => dir !== null);
    const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
    const fallback = versionManagerBinDirs(home, { readLink }).filter((dir) => !live.includes(dir));
    memo = { dirs: [...live, ...fallback] };
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
