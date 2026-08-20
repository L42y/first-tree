import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { runtimeProviderInstallCommand, runtimeProviderLoginCommand } from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  codexDesktopAppBinDirs,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export type CodexRuntimeSource = "bundled" | "path";

export type CodexBinaryFallbackResult<TClient> = {
  client: TClient;
  runtimeSource: CodexRuntimeSource;
  codexPathOverride?: string;
  fallbackReason?: string;
};

export type CodexOptionsLike = {
  codexPathOverride?: string;
  env?: Record<string, string>;
};

export type CodexBinaryFallbackDeps = {
  resolveCandidates?: (env?: Record<string, string>) => Iterable<string>;
  /** Legacy single-candidate seam. Prefer resolveCandidates for new tests. */
  resolvePath?: (env?: Record<string, string>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => CodexExecutableVerification;
  failureTracker?: CodexAutomaticResolutionFailureTracker;
  log?: (message: string) => void;
};

export type CodexExecutableVerification =
  | { ok: true; output?: string }
  | { ok: false; reason: string; transient: boolean };

export type CodexAutomaticCandidateFailure = {
  path: string;
  reason: string;
  transient: boolean;
};

export type CodexVerifiedAutomaticCandidate =
  | {
      ok: true;
      path: string;
      verification: Extract<CodexExecutableVerification, { ok: true }>;
      failures: readonly CodexAutomaticCandidateFailure[];
    }
  | { ok: false; failures: readonly CodexAutomaticCandidateFailure[] };

export type CodexAutomaticResolutionFailureTracker = {
  record(scope: string, fingerprint: string): number;
  reset(scope: string): void;
};

export type CodexAutomaticFailureBoundary = "probe" | "runtime" | "sdk";

/**
 * `codex --version` smoke-check ceiling. A cold `codex` behind a version-manager
 * shim (nvm / fnm / volta / mise / asdf) or on a loaded machine can take several
 * seconds to first respond, so a tight bound turns a present, working binary
 * into a spurious failure. Paired with the transient-vs-missing split below: a
 * verify that flakes (timeout / machine pressure) is retried, not declared
 * permanently missing.
 */
const CODEX_VERSION_VERIFY_TIMEOUT_MS = 10_000;

/**
 * Spawn errnos that mean "the machine couldn't run the check right now", NOT
 * "the binary is broken/absent": the timeout kill, plus transient resource
 * pressure. These map to a transient verification failure (→ retry), never to a
 * missing-binary verdict (→ permanent / needs-operator / terminal).
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM", "ETXTBSY"]);

/**
 * Kill signals that mean "the binary crashed deterministically" — a broken /
 * incompatible native install that will fault the same way on every retry.
 * These must stay NON-transient: classifying them transient would loop a
 * permanently-broken binary through session-bring-up retries forever instead of
 * surfacing an actionable binary failure. Any OTHER signal (the SIGTERM/SIGKILL
 * a `spawnSync` timeout uses to enforce its deadline, an OOM kill, an external
 * shutdown) is a host condition and stays transient.
 */
const DETERMINISTIC_CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGILL",
  "SIGBUS",
  "SIGFPE",
]);

/** Initial attempt plus two retries preserves cold-start recovery without an infinite schedule. */
const CODEX_IDENTICAL_AUTOMATIC_FAILURE_LIMIT = 3;

export function createCodexAutomaticResolutionFailureTracker(): CodexAutomaticResolutionFailureTracker {
  const failuresByScope = new Map<string, { fingerprint: string; count: number }>();
  return {
    record(scope: string, fingerprint: string): number {
      const previous = failuresByScope.get(scope);
      const next = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
      failuresByScope.set(scope, { fingerprint, count: next });
      return next;
    },
    reset(scope: string): void {
      failuresByScope.delete(scope);
    },
  };
}

const defaultAutomaticResolutionFailureTracker = createCodexAutomaticResolutionFailureTracker();

const WINDOWS_CODEX_PLATFORM_PACKAGE_BY_ARCH: Readonly<Record<string, { triple: string; packageName: string }>> = {
  x64: { triple: "x86_64-pc-windows-msvc", packageName: "@openai/codex-win32-x64" },
  arm64: { triple: "aarch64-pc-windows-msvc", packageName: "@openai/codex-win32-arm64" },
};

/**
 * An externally resolved codex binary that EXISTS (resolution already found it) but whose
 * `--version` smoke check did not complete for a transient reason — a spawn
 * timeout, a kill by the timeout signal, or transient resource pressure. The
 * binary is installed; the host was merely too busy / cold to answer in time.
 *
 * This carries a distinct `name` the error taxonomy maps to `transient`, so a
 * flaky check reschedules the session bring-up instead of surfacing as a
 * permanent "Codex runtime binary is missing" terminal failure (which does NOT
 * retry). The message deliberately avoids the missing-binary / capability
 * wording so it never gets re-absorbed into the terminal `capability` bucket.
 */
export class CodexBinaryVerifyTransientError extends Error {
  constructor(reason: string) {
    super(`codex --version smoke check did not complete (transient host condition); will retry. Detail: ${reason}`);
    this.name = "CodexBinaryVerifyTransientError";
  }
}

/**
 * Automatic candidates were present but deterministically unusable, or the
 * exact same all-candidate transient result reached its narrow retry bound.
 * The provider taxonomy maps this named error to a terminal capability reason
 * instead of the generic unknown/transient retry path.
 */
export class CodexBinaryUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexBinaryUnusableError";
  }
}

import { isCodexBinaryMissingError } from "../../runtime/provider-support/index.js";

/** Single-owner match rules live in provider-support; re-export for call sites. */
export { isCodexBinaryMissingError };

export function formatCodexBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Codex runtime binary is missing on this machine. " +
    "First Tree does not bundle the native Codex engine by default — it resolves `codex` from PATH, well-known install directories, or the ChatGPT/Codex desktop app on macOS. " +
    `Install it with the daemon's one-click \`daemon install-codex\` (or \`${runtimeProviderInstallCommand("codex")}\`), then run \`${runtimeProviderLoginCommand("codex")}\` and retry.` +
    suffix
  );
}

export function formatCodexBinaryUnusableMessage(
  failures: readonly CodexAutomaticCandidateFailure[],
  identicalAttempts?: number,
): string {
  const checked = failures.map((failure) => `\`${failure.path.replaceAll("`", "'")}\` (${failure.reason})`).join("; ");
  const repeated = identicalAttempts
    ? ` The same automatic-candidate launch result repeated ${identicalAttempts} times.`
    : "";
  return (
    `Codex runtime binary candidates are installed but unusable. Checked: ${checked}.${repeated} ` +
    `Upgrade or replace the failing Codex installation(s) (for example \`${runtimeProviderInstallCommand("codex")}\`), remove stale candidate paths if needed, then run \`${runtimeProviderLoginCommand("codex")}\` and retry.`
  );
}

export function codexAutomaticCandidateFailureError(
  failures: readonly CodexAutomaticCandidateFailure[],
  env: Record<string, string | undefined>,
  boundary: CodexAutomaticFailureBoundary,
  failureTracker: CodexAutomaticResolutionFailureTracker = defaultAutomaticResolutionFailureTracker,
): CodexBinaryVerifyTransientError | CodexBinaryUnusableError {
  const failureScope = codexAutomaticFailureScope(env, boundary);
  if (failures.some((failure) => failure.transient)) {
    const identicalAttempts = failureTracker.record(failureScope, JSON.stringify(failures));
    if (identicalAttempts < CODEX_IDENTICAL_AUTOMATIC_FAILURE_LIMIT) {
      return new CodexBinaryVerifyTransientError(formatCandidateFailureDetails(failures));
    }
    // A terminal result ends this retry sequence. A later explicit user retry
    // for the same chat must receive a fresh initial attempt plus two retries,
    // and completed chat scopes must not remain in the process-global map.
    failureTracker.reset(failureScope);
    return new CodexBinaryUnusableError(formatCodexBinaryUnusableMessage(failures, identicalAttempts));
  }
  failureTracker.reset(failureScope);
  return new CodexBinaryUnusableError(formatCodexBinaryUnusableMessage(failures));
}

export function resetCodexAutomaticCandidateFailures(
  env: Record<string, string | undefined>,
  boundary: CodexAutomaticFailureBoundary,
  failureTracker: CodexAutomaticResolutionFailureTracker = defaultAutomaticResolutionFailureTracker,
): void {
  failureTracker.reset(codexAutomaticFailureScope(env, boundary));
}

function codexAutomaticFailureScope(
  env: Record<string, string | undefined>,
  boundary: CodexAutomaticFailureBoundary,
): string {
  return `${env.FIRST_TREE_CHAT_ID ?? "__process__"}:${boundary}`;
}

export function resolveVerifiedCodexAutomaticCandidate(
  env: Record<string, string | undefined> = process.env,
  deps: {
    candidates?: Iterable<string>;
    verifyPath?: (path: string, env?: Record<string, string | undefined>) => CodexExecutableVerification;
  } = {},
): CodexVerifiedAutomaticCandidate {
  const failures: CodexAutomaticCandidateFailure[] = [];
  const candidates = deps.candidates ?? findCodexExecutableCandidates(env);
  const verifyPath = deps.verifyPath ?? verifyCodexExecutable;
  for (const path of candidates) {
    const verification = verifyPath(path, env);
    if (verification.ok) return { ok: true, path, verification, failures };
    failures.push({ path, reason: verification.reason, transient: verification.transient });
  }
  return { ok: false, failures };
}

export function createCodexClientWithBinaryFallback<TOptions extends CodexOptionsLike, TClient>(
  options: TOptions,
  construct: (options: TOptions) => TClient,
  deps: CodexBinaryFallbackDeps = {},
): CodexBinaryFallbackResult<TClient> {
  try {
    return { client: construct(options), runtimeSource: "bundled" };
  } catch (err) {
    if (!isCodexBinaryMissingError(err)) throw err;

    // An explicit SDK/config override is authoritative. Automatic discovery
    // must never silently replace a path the caller deliberately selected.
    if (options.codexPathOverride) throw err;

    const candidateSource = deps.resolveCandidates
      ? deps.resolveCandidates(options.env)
      : deps.resolvePath
        ? singleCandidate(deps.resolvePath(options.env))
        : findCodexExecutableCandidates(options.env);
    const resolved = resolveVerifiedCodexAutomaticCandidate(options.env, {
      candidates: candidateSource,
      verifyPath: deps.verifyPath,
    });
    if (!resolved.ok && resolved.failures.length === 0) {
      resetCodexAutomaticCandidateFailures(options.env ?? process.env, "sdk", deps.failureTracker);
      throw new Error(formatCodexBinaryMissingMessage(err));
    }

    if (!resolved.ok) {
      throw codexAutomaticCandidateFailureError(
        resolved.failures,
        options.env ?? process.env,
        "sdk",
        deps.failureTracker,
      );
    }

    resetCodexAutomaticCandidateFailures(options.env ?? process.env, "sdk", deps.failureTracker);
    deps.log?.(
      `Codex SDK bundled binary missing; falling back to codex at ${resolved.path}. ` +
        `Original error: ${errorText(err)}`,
    );
    return {
      client: construct({ ...options, codexPathOverride: resolved.path }),
      runtimeSource: "path",
      codexPathOverride: resolved.path,
      fallbackReason: errorText(err),
    };
  }
}

function singleCandidate(path: string | null): Iterable<string> {
  return path ? [path] : [];
}

function formatCandidateFailureDetails(failures: readonly CodexAutomaticCandidateFailure[]): string {
  return failures.map((failure) => `\`${failure.path.replaceAll("`", "'")}\`: ${failure.reason}`).join("; ");
}

export function verifyCodexExecutable(
  path: string,
  env: Record<string, string | undefined> = process.env,
): CodexExecutableVerification {
  const result = spawnSync(path, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    shell: false,
    timeout: CODEX_VERSION_VERIFY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const timedOut = code === "ETIMEDOUT";
    const transient = timedOut || (typeof code === "string" && TRANSIENT_SPAWN_CODES.has(code));
    return { ok: false, transient, reason: timedOut ? "`codex --version` timed out" : result.error.message };
  }
  // A timeout can surface as a kill signal (e.g. SIGTERM) with no `error`
  // populated. Treat a termination/timeout kill as transient, but a
  // deterministic crash signal (SIGSEGV/SIGABRT/…) as a real broken binary so a
  // permanently-faulting `--version` does not retry forever.
  if (result.signal) {
    const crashed = DETERMINISTIC_CRASH_SIGNALS.has(result.signal);
    return { ok: false, transient: !crashed, reason: `\`codex --version\` killed by ${result.signal}` };
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .join(" ")
      .trim();
    // A clean non-zero exit is the binary answering "I'm broken/incompatible"
    // — a genuine, non-transient install problem.
    return {
      ok: false,
      transient: false,
      reason: `\`codex --version\` exited ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }
  const output = [result.stdout, result.stderr]
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join(" ")
    .trim();
  return { ok: true, output };
}

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type FindCodexExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to the real host list. */
  wellKnownDirs?: () => string[];
  /** Returns macOS desktop-app resource dirs; searched only after every PATH source misses. */
  desktopAppDirs?: () => string[];
  /** Test seams for Windows PATH/shim behaviour without mutating process globals. */
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  pathDelimiter?: string;
};

export function findCodexExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindCodexExecutableDeps = {},
): string | null {
  for (const candidate of findCodexExecutableCandidates(env, deps)) return candidate;
  return null;
}

/**
 * Lazily enumerate automatic external candidates in runtime priority order.
 * Laziness preserves the cheap-source short circuit: login-shell PATH and the
 * desktop-app locations are consulted only when every earlier candidate is
 * absent or fails launch verification.
 */
export function* findCodexExecutableCandidates(
  env: Record<string, string | undefined> = process.env,
  deps: FindCodexExecutableDeps = {},
): Generator<string> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const desktopAppDirs = deps.desktopAppDirs ?? (() => codexDesktopAppBinDirs(home));
  const names = codexExecutableNames(env, platform);
  const seen = new Set<string>();
  const yielded = new Set<string>();

  function* search(dirs: readonly string[]): Generator<string> {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const name of names) {
        const candidate = join(base, name);
        const executable = resolveSpawnableCodexCandidate(candidate, { platform, arch });
        if (executable && !yielded.has(executable)) {
          yielded.add(executable);
          yield executable;
        }
      }
    }
  }

  // Priority: daemon PATH → curated install dirs → login-shell PATH → macOS
  // desktop-app Resources. The login-shell probe may spawn a shell, so cheap
  // sources still short-circuit it. The desktop app is deliberately last: an
  // intentional CLI install visible through nvm / fnm / volta / mise / asdf or
  // a custom export must keep its selected version and credential context.
  // Codex resolution is never on the daemon's pre-connect path.
  const pathValue = readPathValue(env, platform);
  yield* search(pathValue ? pathValue.split(pathDelimiter) : []);
  yield* search(wellKnownDirs());
  yield* search(loginShellPathDirs());
  yield* search(desktopAppDirs());
}

function errorText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const maybe = input as { message?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(input);
}

function readPathValue(env: Record<string, string | undefined>, platform = process.platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "path");
  return key ? env[key] : undefined;
}

function codexExecutableNames(env: Record<string, string | undefined>, platform = process.platform): string[] {
  if (platform !== "win32") return ["codex"];
  const pathExt = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const exts = uniqueStrings(
    pathExt
      .split(";")
      .map((ext) => ext.trim())
      .filter(Boolean),
  );
  const preferred = [".EXE", ".COM"].filter((ext) =>
    exts.some((candidate) => candidate.toLowerCase() === ext.toLowerCase()),
  );
  const rest = exts.filter((ext) => !preferred.some((candidate) => candidate.toLowerCase() === ext.toLowerCase()));
  return uniqueStrings([
    ...preferred.map((ext) => `codex${ext.toLowerCase()}`),
    ...preferred.map((ext) => `codex${ext}`),
    "codex",
    ...rest.map((ext) => `codex${ext.toLowerCase()}`),
    ...rest.map((ext) => `codex${ext}`),
  ]);
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function resolveSpawnableCodexCandidate(
  candidate: string,
  host: { platform: NodeJS.Platform; arch: NodeJS.Architecture },
): string | null {
  if (!isExecutable(candidate)) return null;
  if (host.platform !== "win32") return candidate;

  const ext = extname(candidate).toLowerCase();
  if (ext === ".exe" || ext === ".com") return candidate;

  return resolveWindowsNativeCodexFromNpmShim(candidate, host);
}

function resolveWindowsNativeCodexFromNpmShim(
  candidate: string,
  host: { platform: NodeJS.Platform; arch: NodeJS.Architecture },
): string | null {
  if (host.platform !== "win32") return null;
  const base = candidate
    .slice(candidate.lastIndexOf("\\") + 1)
    .slice(candidate.lastIndexOf("/") + 1)
    .toLowerCase();
  if (!base.startsWith("codex")) return null;

  const target = WINDOWS_CODEX_PLATFORM_PACKAGE_BY_ARCH[host.arch];
  if (!target) return null;

  const packageRoot = join(dirname(candidate), "node_modules", "@openai", "codex");
  const packageJson = join(packageRoot, "package.json");
  if (!fileExists(packageJson)) return null;

  let platformPackageRoot: string | null = null;
  try {
    const requireFromCodex = createRequire(packageJson);
    platformPackageRoot = dirname(requireFromCodex.resolve(`${target.packageName}/package.json`));
  } catch {
    const nested = join(packageRoot, "node_modules", target.packageName);
    if (fileExists(join(nested, "package.json"))) platformPackageRoot = nested;
  }

  const candidates = [
    platformPackageRoot ? join(platformPackageRoot, "vendor", target.triple, "bin", "codex.exe") : null,
    join(packageRoot, "vendor", target.triple, "bin", "codex.exe"),
  ];
  for (const resolved of candidates) {
    if (resolved && isExecutable(resolved)) return resolved;
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  // Vet the complete candidate before `access` follows it — the directory it
  // came from having been vetted says nothing about the leaf, which can itself
  // be a symlink into a protected folder. See `automaticCandidateAllowed`.
  if (!automaticCandidateAllowed(filePath)) return false;
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  if (!automaticCandidateAllowed(filePath)) return false;
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
