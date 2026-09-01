import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { runtimeProviderInstallCommand, runtimeProviderLoginCommand, ZCODE_NPM_PACKAGE } from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export const ZCODE_INSTALL_COMMAND = runtimeProviderInstallCommand("zcode");
export const ZCODE_LOGIN_COMMAND = runtimeProviderLoginCommand("zcode");

function errorText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}

export function formatZcodeBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    `ZCode CLI is missing on this machine. Install the pinned wrapper with \`${ZCODE_INSTALL_COMMAND}\`, ` +
    `then complete provider-owned setup with \`${ZCODE_LOGIN_COMMAND}\` and retry.${suffix}`
  );
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  if (!automaticCandidateAllowed(filePath)) return false;
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type FindZcodeExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

export function findZcodeExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindZcodeExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const directory of dirs) {
      if (!directory) continue;
      const base = isAbsolute(directory) ? directory : resolve(directory);
      if (seen.has(base)) continue;
      seen.add(base);
      const candidate = join(base, platform === "win32" ? "zcode.cmd" : "zcode");
      if (isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  return (
    search(pathDirs) ??
    search([join(home, ".zcode", "cli", "bin")]) ??
    search(wellKnownDirs()) ??
    search((deps.loginShellPathDirs ?? getLoginShellPathDirs)())
  );
}

export type ZcodeRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export function resolveZcodeRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: { findOnPath?: typeof findZcodeExecutableOnPath } = {},
): ZcodeRuntimeBinaryResolution {
  const binary = (deps.findOnPath ?? findZcodeExecutableOnPath)(env);
  if (!binary) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage(`no zcode binary resolved; expected ${ZCODE_NPM_PACKAGE}`),
      transient: false,
    };
  }
  return { ok: true, binary };
}

export type ZcodeTurnArgsInput = {
  workspace: string;
  prompt: string;
  mode: "build" | "edit" | "plan";
  resumeSessionId: string | null;
};

/**
 * Canonical machine turn. Prompt text rides as one argv value through
 * `spawn(..., { shell: false })`; never through a shell or config file.
 */
export function buildZcodeTurnArgs(input: ZcodeTurnArgsInput): string[] {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("ZCode turn prompt is empty");
  const args = ["--json", "--no-color", "--mode", input.mode, "--cwd", input.workspace, "--prompt", prompt];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}
