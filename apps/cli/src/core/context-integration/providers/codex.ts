import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import type {
  ContextIntegrationProviderDriver,
  ProviderCommandRunner,
  ProviderPluginProbe,
} from "../provider-driver.js";
import { parseProviderVersion, pluginIdentity } from "../provider-driver.js";
import { containsPlugin, defaultProviderCommandRunner, safeProviderProbe } from "./shared.js";

export class CodexContextIntegrationDriver implements ContextIntegrationProviderDriver {
  readonly provider = "codex" as const;
  readonly executable: string;
  readonly minimumVersion: string;

  constructor(
    private readonly run: ProviderCommandRunner = defaultProviderCommandRunner,
    options: { executable?: string; minimumVersion?: string } = {},
  ) {
    this.executable = options.executable ?? "codex";
    this.minimumVersion = options.minimumVersion ?? "0.144.0";
  }

  probe(marketplaceName: string, pluginName: string): ProviderPluginProbe {
    const versionResult = safeProviderProbe(() => this.run(this.executable, ["--version"]));
    const version = versionResult ? parseProviderVersion(versionResult.stdout) : null;
    const list = safeProviderProbe(() => JSON.parse(this.run(this.executable, ["plugin", "list", "--json"]).stdout));
    const detectedPlugin = list
      ? containsPlugin(list, pluginName, marketplaceName)
      : { installed: false, enabled: false, installedPath: null, installedVersion: null };
    const plugin = {
      installed: detectedPlugin.installed,
      enabled: detectedPlugin.enabled,
      installedPath:
        detectedPlugin.installedPath ??
        resolveCodexInstalledPluginPath(marketplaceName, pluginName, detectedPlugin.installedVersion),
    };
    const issues: string[] = [];
    if (!versionResult) issues.push("Codex executable was not found.");
    if (version && semver.lt(version, this.minimumVersion)) {
      issues.push(`Codex ${version} is older than the required ${this.minimumVersion}.`);
    }
    if (versionResult && !list) issues.push("Codex Plugin state could not be inspected.");
    return {
      provider: this.provider,
      binaryAvailable: versionResult !== null,
      version,
      compatible: version !== null && semver.gte(version, this.minimumVersion),
      ...plugin,
      hookTrust: plugin.installed ? "review_required" : "unknown",
      issues,
    };
  }

  validateMarketplace(_marketplaceRoot: string): void {
    // Codex validates the marketplace and Plugin package during `marketplace add`
    // and `plugin add`. The release build separately runs the canonical Plugin
    // validator before publication.
  }

  install(request: { marketplaceRoot: string; marketplaceName: string; pluginName: string }): ProviderPluginProbe {
    this.uninstall({ marketplaceName: request.marketplaceName, pluginName: request.pluginName });
    this.run(this.executable, ["plugin", "marketplace", "add", request.marketplaceRoot, "--json"]);
    this.run(this.executable, ["plugin", "add", pluginIdentity(request.pluginName, request.marketplaceName), "--json"]);
    const result = this.probe(request.marketplaceName, request.pluginName);
    if (!result.installed || !result.enabled) {
      throw new Error("Codex did not report the First Tree Context Plugin as installed and enabled.");
    }
    return result;
  }

  uninstall(request: { marketplaceName: string; pluginName: string }): void {
    const identity = pluginIdentity(request.pluginName, request.marketplaceName);
    const probe = this.probe(request.marketplaceName, request.pluginName);
    if (!probe.binaryAvailable) {
      throw new Error("Codex is unavailable, so First Tree cannot verify or remove its user-scope Plugin.");
    }
    if (probe.issues.includes("Codex Plugin state could not be inspected.")) {
      throw new Error("Codex Plugin state could not be inspected safely; no uninstall was attempted.");
    }
    if (probe.installed) this.run(this.executable, ["plugin", "remove", identity, "--json"]);
    const marketplaces = JSON.parse(this.run(this.executable, ["plugin", "marketplace", "list", "--json"]).stdout);
    if (JSON.stringify(marketplaces).includes(request.marketplaceName)) {
      this.run(this.executable, ["plugin", "marketplace", "remove", request.marketplaceName, "--json"]);
    }
  }
}

function resolveCodexInstalledPluginPath(
  marketplaceName: string,
  pluginName: string,
  version: string | null,
): string | null {
  if (!version) return null;
  const path = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "plugins",
    "cache",
    marketplaceName,
    pluginName,
    version,
  );
  return existsSync(path) ? path : null;
}
