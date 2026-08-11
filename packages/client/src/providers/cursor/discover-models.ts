import type { ProviderModelCatalog, ProviderModelOption } from "@first-tree/shared";
import { runCommand } from "../../runtime/capabilities/launch-probe.js";
import { findCursorExecutableOnPath } from "./binary.js";

/** Ceiling for `agent models` — account catalog fetch can be network-bound. */
const CURSOR_MODELS_TIMEOUT_MS = 20_000;

export type CursorDiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  findCursorBinary?: (env?: Record<string, string | undefined>) => string | null;
  runCursorModels?: (
    binary: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
};

function fetchedAt(deps: { now?: () => Date }): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function unavailableCatalog(error: string, deps: { now?: () => Date }): ProviderModelCatalog {
  return {
    provider: "cursor",
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

/**
 * Parse `agent models` / `agent --list-models` text:
 *   Available models
 *   auto - Auto (default)
 *   gpt-5.2 - GPT-5.2
 *
 * Uses indexOf/slice instead of `\s+` / `.+` regexes so CodeQL does not flag
 * polynomial-time matching on CLI stdout.
 */
export function parseCursorModelsOutput(stdout: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const models: ProviderModelOption[] = [];
  let defaultModelId: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase() === "available models") continue;
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep);
    // Model ids are single tokens (`auto`, `gpt-5.2`); reject spaced ids.
    if (!id || id.includes(" ") || id.includes("\t")) continue;
    let label = line.slice(sep + 3).trim();
    const defaultMarker = "(default)";
    const defaultAt = label.toLowerCase().indexOf(defaultMarker);
    const isDefault = defaultAt >= 0;
    if (isDefault) {
      defaultModelId = id;
      label = `${label.slice(0, defaultAt)}${label.slice(defaultAt + defaultMarker.length)}`.trim();
    }
    models.push({
      id,
      label: label || id,
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId };
}

export async function discoverCursorModels(deps: CursorDiscoverModelsDeps = {}): Promise<ProviderModelCatalog> {
  const env = deps.env ?? process.env;
  const findBinary = deps.findCursorBinary ?? findCursorExecutableOnPath;
  const binary = findBinary(env);
  if (!binary) {
    return unavailableCatalog("cursor-agent / agent binary not found on this host", deps);
  }
  const run =
    deps.runCursorModels ??
    (async (bin, processEnv) => {
      const result = await runCommand(bin, ["models"], { timeoutMs: CURSOR_MODELS_TIMEOUT_MS, env: processEnv });
      return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
    });
  const result = await run(binary, env);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "agent models failed").trim();
    return unavailableCatalog(detail.slice(0, 500), deps);
  }
  const parsed = parseCursorModelsOutput(result.stdout);
  if (parsed.models.length === 0) {
    return unavailableCatalog("agent models returned no parseable model rows", deps);
  }
  return {
    provider: "cursor",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-cli",
    error: null,
  };
}
