import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { runtimeProviderInstallCommand, runtimeProviderLoginCommand, ZCODE_NPM_PACKAGE } from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export const ZCODE_INSTALL_COMMAND = runtimeProviderInstallCommand("zcode");
export const ZCODE_LOGIN_COMMAND = runtimeProviderLoginCommand("zcode");
export const ZCODE_MINIMUM_NODE_VERSION = "22.19.0";

const execFileAsync = promisify(execFile);

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

/**
 * The pinned launcher owns this provider-created setup marker. Reading only
 * its existence lets First Tree translate the launcher's generic clean-host
 * turn envelope without opening, copying, or interpreting credential material.
 */
export function zcodeSetupPendingPath(env: Record<string, string | undefined> = process.env): string {
  const platform = process.platform;
  const configuredHome = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  return join(home, ".zcode", "cli", "setup-pending");
}

export function readZcodeSetupPending(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return existsSync(zcodeSetupPendingPath(env));
  } catch {
    return false;
  }
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

function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const [leftMajor, leftMinor, leftPatch] = parse(left);
  const [rightMajor, rightMinor, rightPatch] = parse(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

export type ZcodeVersionInspection =
  | { ok: true; wrapperVersion: string; runtimeVersion: string }
  | { ok: false; error: string; transient: false };

export function inspectZcodeVersion(output: string): ZcodeVersionInspection {
  const rows = output
    .trim()
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  const expected = ZCODE_NPM_PACKAGE.split("@")[1];
  const wrapper = /^zcode-app-cli (\S+)$/.exec(rows[0] ?? "")?.[1];
  const runtime = /^zcode-runtime (\S+)$/.exec(rows[1] ?? "")?.[1];
  if (!wrapper || !runtime) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage(
        `cannot verify the pinned ZCode wrapper/runtime contract (expected \`${ZCODE_NPM_PACKAGE}\`)`,
      ),
      transient: false,
    };
  }
  if (wrapper !== expected || runtime !== expected) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage(
        `incompatible ZCode wrapper/runtime versions: wrapper=${wrapper}, runtime=${runtime}, expected=${expected}`,
      ),
      transient: false,
    };
  }
  return { ok: true, wrapperVersion: wrapper, runtimeVersion: runtime };
}

export type ResolveZcodeRuntimeBinaryDeps = {
  findOnPath?: typeof findZcodeExecutableOnPath;
  readVersion?: (binary: string) => Promise<string>;
  nodeVersion?: () => string;
};

async function readZcodeVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["--version"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    shell: false,
  });
  return stdout;
}

export async function resolveZcodeRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveZcodeRuntimeBinaryDeps = {},
): Promise<ZcodeRuntimeBinaryResolution> {
  const binary = (deps.findOnPath ?? findZcodeExecutableOnPath)(env);
  if (!binary) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage(`no zcode binary resolved; expected ${ZCODE_NPM_PACKAGE}`),
      transient: false,
    };
  }
  const node = (deps.nodeVersion ?? (() => process.versions.node))();
  try {
    if (compareSemanticVersions(node, ZCODE_MINIMUM_NODE_VERSION) < 0) {
      return {
        ok: false,
        error: formatZcodeBinaryMissingMessage(
          `Node.js ${ZCODE_MINIMUM_NODE_VERSION}+ is required; this host is running ${node}`,
        ),
        transient: false,
      };
    }
    const inspection = inspectZcodeVersion(await (deps.readVersion ?? readZcodeVersion)(binary));
    return inspection.ok ? { ok: true, binary } : inspection;
  } catch (error) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage(
        `the resolved binary did not answer \`zcode --version\`: ${error instanceof Error ? error.message : String(error)}`,
      ),
      transient: false,
    };
  }
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
