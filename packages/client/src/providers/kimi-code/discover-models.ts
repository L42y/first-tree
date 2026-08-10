import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModelCatalog, ProviderModelOption } from "@first-tree/shared";
import { parse as parseToml } from "smol-toml";

export type KimiDiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readKimiConfig?: () => Promise<string | null>;
  kimiConfigPath?: string;
};

function fetchedAt(deps: { now?: () => Date }): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function unavailableCatalog(error: string, deps: { now?: () => Date }): ProviderModelCatalog {
  return {
    provider: "kimi-code",
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

/**
 * Parse Kimi Code `config.toml` model tables via a real TOML parser so we
 * accept both quoted headers (`[models."kimi-code/k3"]`) and bare aliases
 * (`[models.gemini-3-pro-preview]`) documented by Kimi.
 */
export function parseKimiConfigModels(toml: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  let data: Record<string, unknown>;
  try {
    data = parseToml(toml) as Record<string, unknown>;
  } catch {
    return { models: [], defaultModelId: null };
  }

  const defaultModelId = typeof data.default_model === "string" ? data.default_model : null;
  const modelsRaw = data.models;
  if (!modelsRaw || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) {
    return { models: [], defaultModelId };
  }

  const models: ProviderModelOption[] = [];
  for (const [id, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
    if (!id || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const displayName = typeof row.display_name === "string" ? row.display_name : undefined;
    const isDefault = defaultModelId === id;
    models.push({
      id,
      ...(displayName ? { label: displayName } : {}),
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId };
}

/** Effective Kimi config path: `$KIMI_CODE_HOME/config.toml` or `~/.kimi-code/config.toml`. */
export function resolveKimiConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const custom = env.KIMI_CODE_HOME?.trim();
  const root = custom && custom.length > 0 ? custom : join(home, ".kimi-code");
  return join(root, "config.toml");
}

export async function discoverKimiModels(deps: KimiDiscoverModelsDeps = {}): Promise<ProviderModelCatalog> {
  const env = deps.env ?? process.env;
  const path = deps.kimiConfigPath ?? resolveKimiConfigPath(env);
  const read =
    deps.readKimiConfig ??
    (async () => {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        if (code === "ENOENT") return null;
        throw err;
      }
    });
  let toml: string | null;
  try {
    toml = await read();
  } catch (err) {
    return unavailableCatalog(err instanceof Error ? err.message : String(err), deps);
  }
  if (toml == null) {
    return unavailableCatalog(`Kimi config not found at ${path}`, deps);
  }
  const parsed = parseKimiConfigModels(toml);
  if (parsed.models.length === 0) {
    return unavailableCatalog("Kimi config has no [models.*] entries", deps);
  }
  return {
    provider: "kimi-code",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-config",
    error: null,
  };
}
