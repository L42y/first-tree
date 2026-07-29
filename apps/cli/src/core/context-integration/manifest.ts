import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContextIntegrationInstallManifest,
  type ContextIntegrationProvider,
  contextIntegrationInstallManifestSchema,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";

export function contextIntegrationInstallManifestPath(provider: ContextIntegrationProvider): string {
  return join(defaultHome(), "state", "context", "providers", provider, "install.json");
}

export function readContextIntegrationInstallManifest(
  provider: ContextIntegrationProvider,
): ContextIntegrationInstallManifest | null {
  const path = contextIntegrationInstallManifestPath(provider);
  try {
    return contextIntegrationInstallManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Invalid Context integration install manifest at ${path}.`, {
      cause: error,
    });
  }
}

export function writeContextIntegrationInstallManifest(manifest: ContextIntegrationInstallManifest): void {
  const parsed = contextIntegrationInstallManifestSchema.parse(manifest);
  const path = contextIntegrationInstallManifestPath(parsed.provider);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function removeContextIntegrationInstallManifest(provider: ContextIntegrationProvider): void {
  rmSync(contextIntegrationInstallManifestPath(provider), { force: true });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
