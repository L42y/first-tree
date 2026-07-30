import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContextIntegrationProvider,
  type ContextIntegrationReleaseManifest,
  contextIntegrationReleaseManifestSchema,
} from "@first-tree/shared";
import { channelConfig } from "../channel.js";
import { COMMAND_VERSION } from "../version.js";

export type ContextIntegrationRelease = {
  root: string;
  manifest: ContextIntegrationReleaseManifest;
};

export function resolveContextIntegrationRelease(overrideRoot?: string): ContextIntegrationRelease {
  const candidates = overrideRoot
    ? [overrideRoot]
    : [
        new URL("../../../context-integration/", import.meta.url),
        new URL("../../context-integration/", import.meta.url),
        new URL("../context-integration/", import.meta.url),
      ].map((url) => fileURLToPath(url));
  const root = candidates.find((candidate) => existsSync(join(candidate, "release-manifest.json")));
  if (!root) {
    throw new Error(
      "This First Tree installation does not contain the Context integration release payload. Reinstall or upgrade First Tree.",
    );
  }
  const manifest = contextIntegrationReleaseManifestSchema.parse(
    JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
  );
  if (manifest.channel !== channelConfig.channel) {
    throw new Error(
      `Context integration channel mismatch: CLI is ${channelConfig.channel}, payload is ${manifest.channel}.`,
    );
  }
  if (COMMAND_VERSION !== "unknown" && manifest.version !== COMMAND_VERSION) {
    throw new Error(`Context integration version mismatch: CLI is ${COMMAND_VERSION}, payload is ${manifest.version}.`);
  }
  verifyContextIntegrationRelease({ root, manifest });
  return { root, manifest };
}

export function verifyContextIntegrationRelease(release: ContextIntegrationRelease): void {
  const policyDigests = new Set<string>();
  for (const provider of ["claude-code", "codex"] as const) {
    const pluginRoot = providerPluginRoot(release.root, provider);
    const adapterDigest = treeDigest(pluginRoot);
    if (adapterDigest !== release.manifest.providers[provider].adapterDigest) {
      throw new Error(`Context integration ${provider} adapter digest mismatch.`);
    }
    for (const skill of ["first-tree-read", "first-tree-write"]) {
      const path = join(pluginRoot, "skills", skill, "references", "context-tree-policy.md");
      policyDigests.add(sha256(readFileSync(path)));
    }
    if (!existsSync(join(pluginRoot, "skills", "first-tree", "SKILL.md"))) {
      throw new Error(`External ${provider} Plugin must expose the first-tree manual activation Skill.`);
    }
    if (existsSync(join(pluginRoot, "skills", "first-tree-seed"))) {
      throw new Error(`External ${provider} Plugin must not expose first-tree-seed.`);
    }
  }
  if (policyDigests.size !== 1 || !policyDigests.has(release.manifest.policyDigest)) {
    throw new Error("Context integration canonical Policy digest mismatch.");
  }
}

export function providerPluginRoot(releaseRoot: string, provider: ContextIntegrationProvider): string {
  return join(releaseRoot, provider, "plugins", "first-tree-context");
}

export function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const path of normalizedFiles(root)) {
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`Unsupported Context integration release entry: ${path}`);
    }
  };
  visit(root);
  return files;
}
