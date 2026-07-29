import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { wellKnownBinDirs } from "./install-locations.js";
import { getLoginShellPathDirs } from "./login-shell-path.js";

/** Exact CLI contract validated by the cross-platform harness. */
export const OPENCODE_SUPPORTED_VERSION = "1.18.7";
/** Host-local OpenCode installation surfaced in setup and error copy. */
export const OPENCODE_INSTALL_COMMAND = `npm install -g opencode-ai@${OPENCODE_SUPPORTED_VERSION}`;
export const OPENCODE_LOGIN_COMMAND = "opencode auth login";

export function formatOpenCodeBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "OpenCode CLI is missing on this machine. " +
    "First Tree does not bundle or install OpenCode and never reads its provider credentials. " +
    `Install it with \`${OPENCODE_INSTALL_COMMAND}\`, then complete provider-owned setup with ` +
    `\`${OPENCODE_LOGIN_COMMAND}\` and retry.` +
    suffix
  );
}

export function isOpenCodeBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /opencode cli is missing|opencode.*not (?:found|installed)/i.test(text);
}

export type FindOpenCodeExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/** Existence-only resolver shared by capability detection and the handler. */
export function findOpenCodeExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindOpenCodeExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const candidate of openCodeExecutableCandidates(base, platform)) {
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  return search(pathDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

export type OpenCodeRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export type OpenCodeRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every OpenCode invocation, including the exact-version gate,
 * is launched later through the provider process supervisor so Windows never
 * executes an unadmitted runtime process.
 */
export function resolveOpenCodeRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: OpenCodeRuntimeResolveDeps = {},
): OpenCodeRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findOpenCodeExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatOpenCodeBinaryMissingMessage("no opencode binary resolved"),
      transient: false,
    };
  }
  return { ok: true, binary };
}

/**
 * npm exposes global Windows CLIs through `.cmd` shims, which cannot be
 * launched with `shell: false` and cannot be pre-admitted as the OpenCode root
 * process. Resolve the package's native executable beside the shim instead.
 */
function openCodeExecutableCandidates(base: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [join(base, "opencode")];
  const candidates = [join(base, "opencode.exe"), join(base, "node_modules", "opencode-ai", "bin", "opencode.exe")];
  if (basename(base).toLowerCase() === ".bin") {
    candidates.push(join(dirname(base), "opencode-ai", "bin", "opencode.exe"));
  }
  return candidates;
}

export function parseOpenCodeVersionOutput(output: string): string | null {
  return output.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorText(input: unknown): string {
  if (input instanceof Error) return `${input.name} ${input.message}`;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}
