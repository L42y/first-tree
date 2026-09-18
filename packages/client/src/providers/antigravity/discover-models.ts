import type { ProviderModelCatalog, ProviderModelOption } from "@first-tree/shared";
import { runCommand } from "../capabilities/launch-probe.js";
import { resolveAntigravityRuntimeBinary } from "./binary.js";

/** Ceiling for `agy models` — the account catalog fetch can be network-bound. */
const ANTIGRAVITY_MODELS_TIMEOUT_MS = 20_000;

export type AntigravityDiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  resolveAntigravityBinary?: (env: NodeJS.ProcessEnv) => { ok: true; binary: string } | { ok: false; error: string };
  runAntigravityModels?: (
    binary: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
};

function fetchedAt(deps: { now?: () => Date }): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function unavailableCatalog(error: string, deps: { now?: () => Date }): ProviderModelCatalog {
  return {
    provider: "antigravity",
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeSlug(id: string): boolean {
  if (!id || id.includes(" ") || id.includes("\t")) return false;
  const first = id.charCodeAt(0);
  const firstOk = (first >= 48 && first <= 57) || (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!firstOk) return false;
  for (let i = 1; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 46 ||
      code === 95;
    if (!ok) return false;
  }
  return true;
}

function optionFromUnknown(value: unknown): ProviderModelOption | null {
  if (typeof value === "string") {
    const id = value.trim();
    return looksLikeSlug(id) ? { id, label: id } : null;
  }
  if (!isRecord(value)) return null;
  const idRaw = value.id ?? value.slug ?? value.model_id ?? value.modelId ?? value.model;
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (!looksLikeSlug(id)) return null;
  const labelRaw = value.label ?? value.name ?? value.display_name ?? value.displayName;
  const label = typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim() : id;
  const isDefault = value.isDefault === true || value.default === true;
  return { id, label, ...(isDefault ? { isDefault: true, hint: "default" } : {}) };
}

function parseAntigravityModelsJson(stdout: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : isRecord(value) && Array.isArray(value.available_models)
        ? value.available_models
        : isRecord(value) && Array.isArray(value.availableModels)
          ? value.availableModels
          : null;
  if (!rows) return null;
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  let defaultModelId: string | null =
    isRecord(value) && typeof value.defaultModelId === "string" && looksLikeSlug(value.defaultModelId)
      ? value.defaultModelId
      : null;
  for (const row of rows) {
    const option = optionFromUnknown(row);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    models.push(option);
    if (option.isDefault) defaultModelId = option.id;
  }
  return models.length > 0 ? { models, defaultModelId } : null;
}

/**
 * Parse `agy models` text:
 *   gemini-3.8-flash-high     Gemini 3.8 Flash (High)
 *
 * Uses indexOf/slice instead of unbounded regexes so CodeQL does not flag
 * polynomial-time matching on CLI stdout.
 */
export function parseAntigravityModelsOutput(stdout: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const fromJson = parseAntigravityModelsJson(stdout);
  if (fromJson) return fromJson;

  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  let defaultModelId: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower === "available models" || lower.startsWith("available models:")) continue;
    let end = 0;
    while (end < line.length && line[end] !== " " && line[end] !== "\t") end += 1;
    const id = line.slice(0, end);
    if (!looksLikeSlug(id) || seen.has(id)) continue;
    let label = line.slice(end).trim();
    const defaultMarker = "(default)";
    const defaultAt = label.toLowerCase().indexOf(defaultMarker);
    const isDefault = defaultAt >= 0;
    if (isDefault) {
      defaultModelId = id;
      label = `${label.slice(0, defaultAt)}${label.slice(defaultAt + defaultMarker.length)}`.trim();
    }
    seen.add(id);
    models.push({
      id,
      label: label || id,
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId };
}

export async function discoverAntigravityModels(
  deps: AntigravityDiscoverModelsDeps = {},
): Promise<ProviderModelCatalog> {
  const env = deps.env ?? process.env;
  const resolveBinary = deps.resolveAntigravityBinary ?? ((processEnv) => resolveAntigravityRuntimeBinary(processEnv));
  const resolution = resolveBinary(env);
  if (!resolution.ok) {
    return unavailableCatalog(resolution.error.slice(0, 500), deps);
  }
  const run =
    deps.runAntigravityModels ??
    (async (bin, processEnv) => {
      const json = await runCommand(bin, ["models", "--output-format", "json"], {
        timeoutMs: ANTIGRAVITY_MODELS_TIMEOUT_MS,
        env: processEnv,
      });
      if (json.ok && parseAntigravityModelsOutput(json.stdout).models.length > 0) {
        return { ok: true, stdout: json.stdout, stderr: json.stderr };
      }
      const text = await runCommand(bin, ["models"], {
        timeoutMs: ANTIGRAVITY_MODELS_TIMEOUT_MS,
        env: processEnv,
      });
      return { ok: text.ok, stdout: text.stdout, stderr: text.stderr };
    });
  const result = await run(resolution.binary, env);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "agy models failed").trim();
    return unavailableCatalog(detail.slice(0, 500), deps);
  }
  const parsed = parseAntigravityModelsOutput(result.stdout);
  if (parsed.models.length === 0) {
    return unavailableCatalog("agy models returned no parseable model rows", deps);
  }
  return {
    provider: "antigravity",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-cli",
    error: null,
  };
}
