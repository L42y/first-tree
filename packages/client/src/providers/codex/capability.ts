import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry, CapabilityRuntimeSource } from "@first-tree/shared";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { verifyLaunchable } from "../capabilities/launch-probe.js";
import {
  type CodexAutomaticResolutionFailureTracker,
  type CodexExecutableVerification,
  type CodexVerifiedAutomaticCandidateTracker,
  codexAutomaticCandidateFailureError,
  codexVerifiedAutomaticCandidateTracker,
  findCodexExecutableCandidates,
  formatCodexBinaryMissingMessage,
  resetCodexAutomaticCandidateFailures,
  resetCodexVerifiedAutomaticCandidateIfRejected,
  resolveVerifiedCodexAutomaticCandidate,
  verifyCodexExecutable,
} from "./binary.js";

/**
 * Platform-package map mirrored from `@openai/codex-sdk`'s own binary
 * resolution (src/exec.ts). The probe must look for the SAME binary the runtime
 * spawns — the handler prefers the SDK-bundled vendor binary and only falls
 * back to an external `codex` resolved from PATH, a well-known install
 * directory, or the macOS ChatGPT/Codex desktop app when the bundle is missing.
 */
const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function codexTargetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === "linux") {
    return arch === "x64" ? "x86_64-unknown-linux-musl" : arch === "arm64" ? "aarch64-unknown-linux-musl" : null;
  }
  if (platform === "darwin") {
    return arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null;
  }
  if (platform === "win32") {
    return arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : null;
  }
  return null;
}

/**
 * Find a file inside the installed `@openai/codex-sdk` package to anchor
 * `createRequire` resolution on. Vite SSR (vitest) strips
 * `import.meta.resolve`, so when it is unavailable we walk parent
 * `node_modules` to the same package instead — realpath'd so pnpm symlinks
 * resolve exactly like Node's own (symlink-following) resolution would.
 */
function locateCodexSdkAnchor(): string {
  if (typeof import.meta.resolve === "function") {
    return fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "node_modules", "@openai", "codex-sdk", "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("not found in any parent node_modules");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Replicate the codex-sdk's own `resolveNativePackage` EXACTLY (dist/index.js):
 * the modern layout is used only when BOTH `bin/<codex>` and the
 * `codex-package.json` marker are present; otherwise the legacy
 * `codex/<codex>` layout. Returns null when neither resolves — which is
 * precisely when `new Codex()` fails its native-package layout check
 * and the handler falls back to an externally installed codex. Existence-only.
 */
export function resolveBundledBinaryInPackageRoot(packageRoot: string): string | null {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const modernPath = join(packageRoot, "bin", binaryName);
  if (isFile(modernPath) && isFile(join(packageRoot, "codex-package.json"))) return modernPath;
  const legacyPath = join(packageRoot, "codex", binaryName);
  if (isFile(legacyPath)) return legacyPath;
  return null;
}

/**
 * Locate the bundled codex binary by replaying the SDK's resolution chain:
 * `@openai/codex-sdk` → its `@openai/codex` dep → the per-platform vendor
 * package → vendor root, then the SDK's own `resolveNativePackage` layout
 * check. Errors describe which link of the chain broke. Existence-only — never
 * launches the binary.
 */
export async function resolveBundledCodexBinary(): Promise<
  { ok: true; binary: string } | { ok: false; error: string }
> {
  const triple = codexTargetTriple();
  if (!triple) {
    return { ok: false, error: `unsupported platform for codex: ${process.platform} (${process.arch})` };
  }
  const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return { ok: false, error: `no codex platform package for ${triple}` };

  let sdkEntryPath: string;
  try {
    sdkEntryPath = locateCodexSdkAnchor();
  } catch (err) {
    return {
      ok: false,
      error: `@openai/codex-sdk failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let vendorRoot: string;
  try {
    const sdkRequire = createRequire(sdkEntryPath);
    const codexPackageJsonPath = sdkRequire.resolve("@openai/codex/package.json");
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    vendorRoot = join(dirname(platformPackageJsonPath), "vendor");
  } catch (err) {
    return {
      ok: false,
      error: `unable to locate codex CLI binaries (is @openai/codex installed with optional dependencies?): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const packageRoot = join(vendorRoot, triple);
  const binary = resolveBundledBinaryInPackageRoot(packageRoot);
  if (binary) return { ok: true, binary };
  return {
    ok: false,
    error: `codex binary not found under ${packageRoot} (need bin/codex + codex-package.json marker, or legacy codex/codex)`,
  };
}

/** Resolved runtime binary + provenance — mirrors the handler's bundled-first,
 * external-path-fallback order (PR #1054 `binary.ts`). */
export type CodexBinaryResolution =
  | {
      ok: true;
      binary: string;
      runtimeSource: CapabilityRuntimeSource;
      runtimePath: string | null;
      version: string | null;
    }
  | { ok: false; error: string; cause?: Error };

/** Injectable seams for `resolveCodexRuntimeBinary` (tests only). */
export type CodexRuntimeResolveDeps = {
  resolveBundled?: () => Promise<{ ok: true; binary: string } | { ok: false; error: string }>;
  verifyBundled?: (binary: string) => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  findCandidates?: (env?: Record<string, string | undefined>) => Iterable<string>;
  /** Legacy single-candidate seam. Prefer findCandidates for new tests. */
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => CodexExecutableVerification;
  failureTracker?: CodexAutomaticResolutionFailureTracker;
  verifiedCandidateTracker?: CodexVerifiedAutomaticCandidateTracker;
};

/**
 * Resolve the codex binary the RUNTIME would actually spawn, on the SAME
 * contract as the handler (`createCodexClientWithBinaryFallback`): SDK-bundled
 * vendor binary first (launch-verified), else a validated external `codex`
 * resolved from PATH / known install locations. This is a RUNTIME/handler + login helper — it DOES launch-verify the
 * binary it is about to spawn. It records a successful automatic selection so
 * the separate install-only capability probe can report that last verified
 * artifact without launching provider binaries itself.
 */
export async function resolveCodexRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: CodexRuntimeResolveDeps = {},
): Promise<CodexBinaryResolution> {
  const resolveBundled = deps.resolveBundled ?? resolveBundledCodexBinary;
  const verifyBundled = deps.verifyBundled ?? ((binary: string) => verifyLaunchable("codex", binary));
  const verifyPath = deps.verifyPath ?? verifyCodexExecutable;
  const verifiedCandidateTracker = deps.verifiedCandidateTracker ?? codexVerifiedAutomaticCandidateTracker;

  const bundled = await resolveBundled();
  if (bundled.ok) {
    const verified = await verifyBundled(bundled.binary);
    if (!verified.ok) {
      verifiedCandidateTracker.reset();
      return {
        ok: false,
        error: `the SDK-bundled codex binary at ${bundled.binary} could not be launched (${verified.error})`,
      };
    }
    resetCodexAutomaticCandidateFailures(env, "runtime", deps.failureTracker);
    verifiedCandidateTracker.reset();
    return {
      ok: true,
      binary: bundled.binary,
      runtimeSource: "bundled",
      runtimePath: null,
      version: verified.version,
    };
  }

  const candidates = deps.findCandidates
    ? deps.findCandidates(env)
    : deps.findOnPath
      ? singleCandidate(deps.findOnPath(env))
      : findCodexExecutableCandidates(env);
  const resolved = resolveVerifiedCodexAutomaticCandidate(env, { candidates, verifyPath });
  if (resolved.ok) {
    resetCodexAutomaticCandidateFailures(env, "runtime", deps.failureTracker);
    verifiedCandidateTracker.record(resolved.path);
    const match = (resolved.verification.output ?? "").match(/\d+\.\d+(?:\.\d+)?/);
    return {
      ok: true,
      binary: resolved.path,
      runtimeSource: "path",
      runtimePath: resolved.path,
      version: match ? match[0] : null,
    };
  }
  if (resolved.failures.length > 0) {
    resetCodexVerifiedAutomaticCandidateIfRejected(resolved.failures, verifiedCandidateTracker);
    const failure = codexAutomaticCandidateFailureError(resolved.failures, env, "runtime", deps.failureTracker);
    if (failure.name === "CodexBinaryUnusableError") verifiedCandidateTracker.reset();
    return { ok: false, error: failure.message, cause: failure };
  }

  resetCodexAutomaticCandidateFailures(env, "runtime", deps.failureTracker);
  verifiedCandidateTracker.reset();
  return { ok: false, error: formatCodexBinaryMissingMessage(bundled.error) };
}

function singleCandidate(path: string | null): Iterable<string> {
  return path ? [path] : [];
}

/** Injectable seams — production callers pass nothing. */
export type CodexProbeDeps = {
  resolveBundled?: () => Promise<{ ok: true; binary: string } | { ok: false; error: string }>;
  findCandidates?: (env?: Record<string, string | undefined>) => Iterable<string>;
  /** Legacy single-candidate seam. Prefer findCandidates for new tests. */
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  verifiedCandidateTracker?: CodexVerifiedAutomaticCandidateTracker;
  env?: NodeJS.ProcessEnv;
};

/**
 * Install-only probe for the `codex` runtime.
 *
 * Installed when the binary the runtime would spawn exists — the SDK-bundled
 * vendor binary (per the SDK's own `resolveNativePackage` layout check), or a
 * external `codex` from PATH / known install locations. The probe never
 * launch-verifies external candidates. `runtimePath` is reported only when a
 * still-discoverable path was previously selected and verified by the runtime;
 * otherwise the installed external capability intentionally omits it rather
 * than claiming that the first existence-only candidate is the executed one.
 * Authentication and reachability are no longer probed; a logged-out or
 * unreachable codex is discovered at session run time and surfaced as an
 * in-chat credential failure.
 */
export async function probeCodexCapability(deps: CodexProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const resolveBundled = deps.resolveBundled ?? resolveBundledCodexBinary;
  const verifiedCandidateTracker = deps.verifiedCandidateTracker ?? codexVerifiedAutomaticCandidateTracker;

  return runDetect(async (): Promise<DetectOutcome> => {
    const bundled = await resolveBundled();
    if (bundled.ok) {
      return { installed: true, runtimeSource: "bundled", runtimePath: null };
    }
    const candidates = [
      ...(deps.findCandidates
        ? deps.findCandidates(env)
        : deps.findOnPath
          ? singleCandidate(deps.findOnPath(env))
          : findCodexExecutableCandidates(env)),
    ];
    if (candidates.length > 0) {
      const verifiedPath = verifiedCandidateTracker.get();
      if (verifiedPath && candidates.includes(verifiedPath)) {
        return { installed: true, runtimeSource: "path", runtimePath: verifiedPath };
      }
      if (verifiedPath) verifiedCandidateTracker.reset();
      return { installed: true, runtimeSource: "path" };
    }
    return { installed: false, error: formatCodexBinaryMissingMessage(bundled.error) };
  });
}
