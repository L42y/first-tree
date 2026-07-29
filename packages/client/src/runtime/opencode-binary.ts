import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { wellKnownBinDirs } from "./install-locations.js";
import { getLoginShellPathDirs } from "./login-shell-path.js";

/** Lowest compatible CLI validated by the runtime contract. */
export const OPENCODE_MINIMUM_VERSION = "1.18.7";
export const OPENCODE_SUPPORTED_VERSION_RANGE = ">=1.18.7 <2.0.0";
/** Host-local OpenCode installation surfaced in setup and error copy. */
export const OPENCODE_INSTALL_COMMAND = `npm install -g opencode-ai@^${OPENCODE_MINIMUM_VERSION}`;
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
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
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
  return (
    search(pathDirs) ??
    search([join(home, ".opencode", "bin")]) ??
    search(wellKnownDirs()) ??
    search(loginShellPathDirs())
  );
}

export type OpenCodeRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export type OpenCodeRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every OpenCode invocation, including the compatible-version gate,
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
  for (let start = 0; start < output.length; start++) {
    if (!isAsciiDigit(output.charCodeAt(start))) continue;
    if (start > 0 && isVersionTokenCode(output.charCodeAt(start - 1))) continue;
    const firstDot = scanNumericPart(output, start);
    if (firstDot < 0 || output.charCodeAt(firstDot) !== 46) continue;
    const secondStart = firstDot + 1;
    const secondDot = scanNumericPart(output, secondStart);
    if (secondDot < 0 || output.charCodeAt(secondDot) !== 46) continue;
    const patchStart = secondDot + 1;
    const end = scanNumericPart(output, patchStart);
    if (end < 0) continue;
    if (end < output.length && isVersionTokenCode(output.charCodeAt(end))) {
      start = end;
      continue;
    }
    const parts = [output.slice(start, firstDot), output.slice(secondStart, secondDot), output.slice(patchStart, end)];
    if (parts.every(isBoundedNumericVersionPart)) return parts.join(".");
    start = end;
  }
  return null;
}

export function isSupportedOpenCodeVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".");
  if (parts.length !== 3 || !parts.every(isBoundedNumericVersionPart)) return false;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (major !== 1) return false;
  return minor > 18 || (minor === 18 && patch >= 7);
}

function scanNumericPart(value: string, start: number): number {
  let end = start;
  while (end < value.length && isAsciiDigit(value.charCodeAt(end))) end++;
  return end === start ? -1 : end;
}

function isVersionTokenCode(code: number): boolean {
  return isAsciiDigit(code) || code === 46 || code === 45 || code === 43 || isAsciiLetter(code);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isBoundedNumericVersionPart(part: string): boolean {
  if (part.length < 1 || part.length > 6) return false;
  for (let index = 0; index < part.length; index++) {
    if (!isAsciiDigit(part.charCodeAt(index))) return false;
  }
  return true;
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
