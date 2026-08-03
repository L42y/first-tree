import type {
  ContextActivationV2Response,
  ContextIntegrationGrant,
  ContextIntegrationProject,
} from "@first-tree/shared";
import semver from "semver";
import type { ContextActivationValidator } from "./activation.js";
import { validateExternalContextAuthority } from "./authority.js";
import {
  ContextClientPreflightError,
  type ContextClientPreflightErrorCode,
  inspectContextClientPreflight,
} from "./client-preflight.js";
import { readContextIntegrationConfig, resolveContextGrantCandidates } from "./context-binding-store.js";
import { contextIntegrationMarketplaceName } from "./installer.js";
import type { ContextIntegrationProviderDriver, ProviderHookProbe } from "./provider-driver.js";
import { type ContextIntegrationRuntimeHealth, inspectContextIntegrationRuntime } from "./runtime-health.js";

type ProjectStatus =
  | { state: "ready"; project: ContextIntegrationProject }
  | { state: "unavailable"; reason: ContextClientPreflightErrorCode | "unknown"; message: string; nextAction: string };

type CandidateStatus = {
  grant: ContextIntegrationGrant;
  priority: "directory" | "global";
  activation:
    | { state: "connected"; team: Extract<ContextActivationV2Response, { outcome: "connected" }>["team"] }
    | { state: "needs_admin" | "unavailable"; reasonCode: string; message: string };
};

export type ContextIntegrationStatus = {
  provider: {
    name: ContextIntegrationProviderDriver["provider"];
    available: boolean;
    version: string | null;
    minimumVersion: string;
    compatible: boolean;
  };
  plugin: { installed: boolean; enabled: boolean; installedPath: string | null };
  hook: ProviderHookProbe;
  runtime: { healthy: boolean; issues: string[] };
  project: ProjectStatus;
  persistentGrants: ContextIntegrationGrant[];
  effectiveCandidates: CandidateStatus[];
};

type StatusDependencies = {
  inspectRuntime?: (driver: ContextIntegrationProviderDriver) => ContextIntegrationRuntimeHealth;
  inspectPreflight?: typeof inspectContextClientPreflight;
  resolveCandidates?: typeof resolveContextGrantCandidates;
  readConfig?: typeof readContextIntegrationConfig;
};

export async function inspectContextIntegrationStatus(
  driver: ContextIntegrationProviderDriver,
  validator: ContextActivationValidator,
  selector: { cwd?: string; projectRoot?: string; pathless?: boolean } = {},
  dependencies: StatusDependencies = {},
): Promise<ContextIntegrationStatus> {
  const health = (dependencies.inspectRuntime ?? inspectContextIntegrationRuntime)(driver);
  const plugin = health.probe;
  const marketplaceName = health.install?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = health.install?.pluginName ?? "first-tree-context";
  const hook = await driver.inspectHook({
    marketplaceName,
    pluginName,
    cwd: selector.projectRoot ?? selector.cwd ?? process.cwd(),
    plugin: { installed: plugin.installed, enabled: plugin.enabled },
  });
  const minimumVersion = health.release?.manifest.providers[driver.provider].minimumVersion ?? driver.minimumVersion;
  const base = {
    provider: {
      name: driver.provider,
      available: plugin.binaryAvailable,
      version: plugin.version,
      minimumVersion,
      compatible:
        plugin.binaryAvailable &&
        plugin.version !== null &&
        semver.valid(plugin.version) !== null &&
        semver.gte(plugin.version, minimumVersion),
    },
    plugin: { installed: plugin.installed, enabled: plugin.enabled, installedPath: plugin.installedPath },
    hook,
    runtime: { healthy: health.healthy, issues: health.issues },
    persistentGrants: (dependencies.readConfig ?? readContextIntegrationConfig)().grants.filter(
      (grant) => grant.provider === driver.provider,
    ),
  };
  let resolved: ReturnType<typeof inspectContextClientPreflight>;
  try {
    resolved = (dependencies.inspectPreflight ?? inspectContextClientPreflight)(driver.provider, selector);
  } catch (error) {
    return { ...base, project: projectFailure(error), effectiveCandidates: [] };
  }
  const matches = (dependencies.resolveCandidates ?? resolveContextGrantCandidates)(driver.provider, resolved.project);
  const grants: CandidateStatus[] = [];
  for (const match of matches) {
    const authority = await validateExternalContextAuthority(validator, match.grant.organizationId, "explicit");
    if (authority.outcome === "unavailable") {
      grants.push({
        ...match,
        activation: { state: "unavailable", reasonCode: authority.reasonCode, message: authority.systemMessage },
      });
    } else if (authority.response.outcome === "connected") {
      grants.push({ ...match, activation: { state: "connected", team: authority.response.team } });
    } else {
      grants.push({
        ...match,
        activation: {
          state: "needs_admin",
          reasonCode: authority.response.reasonCode,
          message: authority.response.nextAction.message,
        },
      });
    }
  }
  return { ...base, project: { state: "ready", project: resolved.project }, effectiveCandidates: grants };
}

function projectFailure(error: unknown): Extract<ProjectStatus, { state: "unavailable" }> {
  if (error instanceof ContextClientPreflightError) {
    return { state: "unavailable", reason: error.code, message: error.message, nextAction: error.nextAction };
  }
  return {
    state: "unavailable",
    reason: "unknown",
    message: `The current project could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    nextAction: "Fix the project error and rerun context status.",
  };
}
