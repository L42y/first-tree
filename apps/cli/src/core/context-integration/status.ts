import type {
  ContextActivationResponse,
  ContextIntegrationBinding,
  ContextIntegrationProject,
  ContextIntegrationProvider,
} from "@first-tree/shared";
import semver from "semver";
import { channelConfig } from "../channel.js";
import type { ContextActivationValidator } from "./activation.js";
import { validateExternalContextAuthority } from "./authority.js";
import {
  ContextClientPreflightError,
  type ContextClientPreflightErrorCode,
  inspectContextClientPreflight,
} from "./client-preflight.js";
import { findContextBinding } from "./context-binding-store.js";
import { contextIntegrationMarketplaceName } from "./installer.js";
import type { ContextIntegrationProviderDriver, ProviderHookProbe, ProviderPluginProbe } from "./provider-driver.js";
import { type ContextIntegrationRuntimeHealth, inspectContextIntegrationRuntime } from "./runtime-health.js";

type ProjectStatus =
  | { state: "ready"; project: ContextIntegrationProject }
  | {
      state: "unavailable";
      reason: ContextClientPreflightErrorCode | "unknown";
      message: string;
      nextAction: string;
    };

type BindingStatus =
  | { state: "exact"; organizationId: string }
  | { state: "missing"; nextAction: string }
  | { state: "not_checked"; reason: string };

type LiveActivationStatus =
  | { state: "connected"; team: Extract<ContextActivationResponse, { outcome: "connected" }>["team"] }
  | {
      state: "disabled" | "needs_admin";
      reasonCode: string;
      message: string;
      settingsUrl: string | null;
    }
  | { state: "unavailable"; reasonCode: string; message: string; nextAction: string }
  | { state: "not_checked"; reason: string };

export type ContextIntegrationStatus = {
  provider: {
    name: ContextIntegrationProvider;
    available: boolean;
    version: string | null;
    minimumVersion: string;
    compatible: boolean;
  };
  plugin: { installed: boolean; enabled: boolean; installedPath: string | null };
  hook: ProviderHookProbe;
  runtime: { healthy: boolean; issues: string[] };
  project: ProjectStatus;
  binding: BindingStatus;
  activation: LiveActivationStatus;
};

type StatusDependencies = {
  inspectRuntime?: (driver: ContextIntegrationProviderDriver) => ContextIntegrationRuntimeHealth;
  inspectPreflight?: typeof inspectContextClientPreflight;
  findBinding?: (
    provider: ContextIntegrationProvider,
    project: ContextIntegrationProject,
  ) => ContextIntegrationBinding | null;
};

export async function inspectContextIntegrationStatus(
  driver: ContextIntegrationProviderDriver,
  validator: ContextActivationValidator,
  selector: { cwd?: string; projectRoot?: string; pathless?: boolean } = {},
  dependencies: StatusDependencies = {},
): Promise<ContextIntegrationStatus> {
  const inspectRuntime = dependencies.inspectRuntime ?? inspectContextIntegrationRuntime;
  const inspectPreflight = dependencies.inspectPreflight ?? inspectContextClientPreflight;
  const resolveBinding = dependencies.findBinding ?? findContextBinding;
  const health = inspectRuntime(driver);
  const plugin = health.probe;
  const marketplaceName = health.install?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = health.install?.pluginName ?? "first-tree-context";
  const hookCwd = selector.projectRoot ?? selector.cwd ?? process.cwd();
  const hook = await inspectProviderHook(driver, plugin, { marketplaceName, pluginName, cwd: hookCwd });
  const minimumVersion = health.release?.manifest.providers[driver.provider].minimumVersion ?? driver.minimumVersion;
  const providerStatus = {
    name: driver.provider,
    available: plugin.binaryAvailable,
    version: plugin.version,
    minimumVersion,
    compatible:
      plugin.binaryAvailable &&
      plugin.version !== null &&
      semver.valid(plugin.version) !== null &&
      semver.gte(plugin.version, minimumVersion),
  };
  const pluginStatus = {
    installed: plugin.installed,
    enabled: plugin.enabled,
    installedPath: plugin.installedPath,
  };
  const runtime = { healthy: health.healthy, issues: health.issues };

  let resolved: ReturnType<typeof inspectContextClientPreflight>;
  try {
    resolved = inspectPreflight(driver.provider, selector);
  } catch (error) {
    const project = projectFailure(error);
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      project,
      binding: { state: "not_checked", reason: project.message },
      activation: { state: "not_checked", reason: project.message },
    };
  }

  const project: ProjectStatus = { state: "ready", project: resolved.project };
  let binding: ContextIntegrationBinding | null;
  try {
    binding = resolveBinding(driver.provider, resolved.project);
  } catch (error) {
    const reason = `The project binding could not be read: ${message(error)}`;
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      project,
      binding: { state: "not_checked", reason },
      activation: { state: "not_checked", reason },
    };
  }
  if (!binding) {
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      project,
      binding: {
        state: "missing",
        nextAction: `Run the target Team's \`${channelConfig.binName} context enable\` handoff for this project.`,
      },
      activation: { state: "not_checked", reason: "No provider + project binding exists." },
    };
  }

  const authority = await validateExternalContextAuthority(validator, binding.organizationId, "explicit");
  return {
    provider: providerStatus,
    plugin: pluginStatus,
    hook,
    runtime,
    project,
    binding: { state: "exact", organizationId: binding.organizationId },
    activation:
      authority.outcome === "validated"
        ? activationStatus(authority.response)
        : {
            state: "unavailable",
            reasonCode: authority.reasonCode,
            message: authority.systemMessage,
            nextAction: `Check the First Tree connection and rerun \`${channelConfig.binName} context status --provider ${driver.provider}\`.`,
          },
  };
}

function inspectProviderHook(
  driver: ContextIntegrationProviderDriver,
  plugin: ProviderPluginProbe,
  input: { marketplaceName: string; pluginName: string; cwd: string },
): Promise<ProviderHookProbe> {
  return driver.inspectHook({
    ...input,
    plugin: { installed: plugin.installed, enabled: plugin.enabled },
  });
}

function projectFailure(error: unknown): Extract<ProjectStatus, { state: "unavailable" }> {
  if (error instanceof ContextClientPreflightError) {
    return {
      state: "unavailable",
      reason: error.code,
      message: error.message,
      nextAction: error.nextAction,
    };
  }
  return {
    state: "unavailable",
    reason: "unknown",
    message: `The current project could not be inspected: ${message(error)}`,
    nextAction: `Fix the reported project error, then rerun \`${channelConfig.binName} context status\`.`,
  };
}

function activationStatus(response: ContextActivationResponse): LiveActivationStatus {
  if (response.outcome === "connected") return { state: "connected", team: response.team };
  return {
    state: response.outcome,
    reasonCode: response.reasonCode,
    message: response.nextAction.message,
    settingsUrl: response.nextAction.settingsUrl ?? null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
