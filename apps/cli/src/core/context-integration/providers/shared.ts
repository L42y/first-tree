import { execFileSync } from "node:child_process";
import type { ProviderCommandRunner } from "../provider-driver.js";
import { ProviderCommandError } from "../provider-driver.js";

export const defaultProviderCommandRunner: ProviderCommandRunner = (executable, args) => {
  try {
    const stdout = execFileSync(executable, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr: "" };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stderr =
      typeof failure.stderr === "string"
        ? failure.stderr
        : Buffer.isBuffer(failure.stderr)
          ? failure.stderr.toString("utf8")
          : failure.message;
    throw new ProviderCommandError(executable, args, stderr, { cause: error });
  }
};

export function safeProviderProbe<T>(action: () => T): T | null {
  try {
    return action();
  } catch {
    return null;
  }
}

export function containsPlugin(
  value: unknown,
  pluginName: string,
  marketplaceName: string,
): {
  installed: boolean;
  enabled: boolean;
  installedPath: string | null;
  installedVersion: string | null;
} {
  const targetId = `${pluginName}@${marketplaceName}`;
  const rows = flattenObjects(value);
  const row = rows.find((candidate) => {
    const id = stringField(candidate, ["pluginId", "id", "key"]);
    const name = stringField(candidate, ["name", "pluginName"]);
    const marketplace = stringField(candidate, ["marketplaceName", "marketplace"]);
    return id === targetId || (name === pluginName && marketplace === marketplaceName);
  });
  if (!row) return { installed: false, enabled: false, installedPath: null, installedVersion: null };
  return {
    installed: booleanField(row, ["installed"], true),
    enabled: booleanField(row, ["enabled", "isEnabled"], true),
    installedPath: stringField(row, ["installedPath", "installPath", "path"]),
    installedVersion: stringField(row, ["version"]),
  };
}

function flattenObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((item) => flattenObjects(item));
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap((item) => flattenObjects(item))];
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function booleanField(value: Record<string, unknown>, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
  }
  return fallback;
}
