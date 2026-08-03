import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { buildConnectedContextAdditionalContext } from "../../core/context-integration/activation.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import {
  buildCurrentSessionHandoff,
  type CurrentSessionHandoff,
} from "../../core/context-integration/current-session-handoff.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { enableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import type { ProviderHookProbe } from "../../core/context-integration/provider-driver.js";
import {
  type ContextIntegrationStatus,
  inspectContextIntegrationStatus,
} from "../../core/context-integration/status.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";
import { renderHookEnabled, renderHookTrust } from "./status.js";

type EnableOptions = {
  provider?: string;
  team?: string;
  yes?: boolean;
  projectRoot?: string;
  pathless?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "Team from the server-authored Setup or invite handoff")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "bind the provider's explicit pathless project")
    .option("--yes", "accept the displayed local Plugin/binding change plan");
}

export async function runContextEnable(context: CommandContext): Promise<void> {
  const options = context.command.opts<EnableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const teamId = options.team?.trim() ?? "";
  if (!teamId) {
    print.fail("CONTEXT_TEAM_REQUIRED", "--team must contain the explicit handoff Team id.", 2);
  }
  const expectedAccountClientId = readActiveContextAccountClientId();
  const preflight = inspectContextClientPreflight(provider, {
    projectRoot: options.projectRoot,
    pathless: options.pathless,
  });
  const sdk = createMemberSdk();
  const activation = await sdk.validateMemberContextActivation(
    teamId,
    {
      schemaVersion: 2,
    },
    { retry: false, timeoutMs: 2_000 },
  );
  if (activation.outcome !== "connected") {
    print.fail(
      activation.reasonCode,
      activation.nextAction.message +
        (activation.nextAction.settingsUrl ? ` (${activation.nextAction.settingsUrl})` : ""),
      1,
    );
  }

  const driver = createContextIntegrationDriver(provider);
  const installPlan = planContextIntegrationInstall(driver);
  let expectedConfig: ReturnType<typeof readContextIntegrationConfig>;
  let previousBinding: ReturnType<typeof findContextBinding>;
  try {
    expectedConfig = readContextIntegrationConfig();
    previousBinding = findContextBinding(provider, preflight.project);
  } catch (error) {
    // Fail closed before displaying a plan built on unknown previous
    // bindings; the shared config must never be deleted to recover.
    print.fail(
      "CONTEXT_BINDING_CONFIG_UNREADABLE",
      `${error instanceof Error ? error.message : String(error)} Do not delete the binding config — it also holds bindings for other providers and projects. Back it up, then repair its file permissions or YAML together with the member before re-running this command.`,
      1,
    );
    throw error;
  }
  print.status("Provider", provider);
  print.status("Plugin", installPlan.operation);
  print.status("Project", renderProject(preflight.project));
  print.status("Team binding", previousBinding ? `${previousBinding.organizationId} → ${teamId}` : `add ${teamId}`);

  const accepted =
    options.yes === true ||
    (!context.options.json &&
      (await confirm({
        message: "Apply this user-scope Plugin and project binding change?",
        default: true,
      })));
  if (!accepted) print.fail("CONTEXT_ENABLE_CANCELLED", "No changes were applied.", 2);

  enableContextIntegrationOperation(
    driver,
    installPlan,
    {
      provider,
      project: preflight.project,
      organizationId: teamId,
    },
    expectedConfig,
    expectedAccountClientId,
  );

  const verification = await inspectContextIntegrationStatus(driver, sdk, {
    ...(preflight.project.kind === "path" ? { projectRoot: preflight.project.root } : { pathless: true }),
  });
  const missingLayers = collectMissingSetupLayers(provider, verification);
  const handoffIdentityIssues = collectHandoffIdentityIssues(preflight.project, teamId, verification);
  missingLayers.push(...handoffIdentityIssues);
  const activationContext =
    verification.activation.state === "connected" && handoffIdentityIssues.length === 0
      ? buildConnectedContextAdditionalContext(verification.activation.team)
      : null;
  let currentSessionHandoff: CurrentSessionHandoff | null = null;
  let currentSessionHandoffIssue: string | null = null;
  if (missingLayers.length === 0) {
    try {
      if (verification.activation.state !== "connected" || !verification.plugin.installedPath) {
        throw new Error("Verified activation or provider-installed Plugin path is unavailable.");
      }
      currentSessionHandoff = buildCurrentSessionHandoff({
        provider,
        project: preflight.project,
        team: verification.activation.team,
        installedPluginRoot: verification.plugin.installedPath,
      });
    } catch (error) {
      currentSessionHandoffIssue = error instanceof Error ? error.message : String(error);
      missingLayers.push("Current-session handoff: unavailable");
    }
  }
  const setup = { complete: missingLayers.length === 0, missingLayers };
  const nextActions = buildSetupNextActions(
    provider,
    verification,
    setup,
    channelConfig.binName,
    currentSessionHandoffIssue,
    handoffIdentityIssues,
  );
  const verifiedTeam = verification.activation.state === "connected" ? verification.activation.team : activation.team;
  const result = {
    provider,
    team: verifiedTeam,
    requestedTeam: activation.team,
    project: preflight.project,
    plugin: installPlan.operation,
    verification,
    setup,
    activationContext,
    currentSessionHandoff,
    nextActions,
  };
  if (context.options.json) print.result(result);
  else {
    print.status(
      "Context",
      handoffIdentityIssues.length === 0
        ? `Enabled for ${verifiedTeam.displayName}`
        : `Requested ${activation.team.displayName}; final project/Team identity changed during verification`,
    );
    print.status("Plugin installed", verification.plugin.installed ? "Yes" : "No");
    print.status("Plugin enabled", verification.plugin.enabled ? "Yes" : "No");
    print.status("Hook trusted", renderHookTrust(verification.hook));
    print.status("Hook enabled", renderHookEnabled(verification.hook));
    print.status(
      "Project binding",
      verification.binding.state === "exact"
        ? `Connected — Team ${verification.binding.organizationId}`
        : `Unavailable — ${verification.binding.state}`,
    );
    print.status(
      "Live activation",
      verification.activation.state === "connected"
        ? `Connected — ${verification.activation.team.displayName}`
        : verification.activation.state,
    );
    print.status("Current-session handoff", currentSessionHandoff ? "Ready" : "Unavailable");
    print.line(`\n${renderSetupVerdictLine(setup)}\n`);
    if (currentSessionHandoff) {
      print.line(
        preflight.project.kind === "path"
          ? "\nAdopt this complete verified current-session handoff JSON in this coding-agent session now; future sessions in this project activate automatically:\n\n"
          : "\nAdopt this complete verified current-session handoff JSON in this coding-agent session now. Pathless sessions activate manually:\n\n",
      );
      print.line(`${JSON.stringify(currentSessionHandoff, null, 2)}\n`);
      print.line("\nCanonical Team Context (also present byte-for-byte in the handoff):\n\n");
      print.line(`${currentSessionHandoff.activationContext}\n`);
    } else if (activationContext) {
      print.line(
        "\nLive Team Context was verified, but it is not ready for current-session adoption. Finish the Next steps below and re-run this command:\n\n",
      );
      print.line(`${activationContext}\n`);
    }
    nextActions.forEach((action, index) => {
      print.status(`Next ${index + 1}`, action);
    });
  }
}

/**
 * Layered setup verdict: every layer the BYO setup prompt tells the agent to
 * trust must be green before the command reports `Setup: Complete`, including
 * provider compatibility and the installed payload's runtime health — a
 * damaged or mismatched payload must not verify. The hook layers apply only
 * to Codex; Claude Code hooks are provider-managed.
 */
export function collectMissingSetupLayers(
  provider: "claude-code" | "codex",
  verification: Pick<
    ContextIntegrationStatus,
    "provider" | "plugin" | "hook" | "runtime" | "project" | "binding" | "activation"
  >,
): string[] {
  return [
    ...(verification.provider.available ? [] : ["Provider available: No"]),
    ...(verification.provider.compatible ? [] : ["Provider compatible: No"]),
    ...(verification.plugin.installed ? [] : ["Plugin installed: No"]),
    ...(verification.plugin.enabled ? [] : ["Plugin enabled: No"]),
    ...(verification.runtime.healthy ? [] : ["Plugin payload healthy: No"]),
    ...(provider === "codex" &&
    verification.project.state === "ready" &&
    verification.project.project.kind === "path" &&
    verification.hook.trust !== "trusted"
      ? ["Hook trusted: No"]
      : []),
    ...(provider === "codex" &&
    verification.project.state === "ready" &&
    verification.project.project.kind === "path" &&
    verification.hook.enabled !== true
      ? ["Hook enabled: No"]
      : []),
    ...(verification.project.state === "ready" ? [] : ["Project: unavailable"]),
    ...(verification.binding.state === "exact" ? [] : [`Project binding: ${verification.binding.state}`]),
    ...(verification.activation.state === "connected" ? [] : [`Live activation: ${verification.activation.state}`]),
  ];
}

/**
 * The final status read happens after the install/binding transaction lock is
 * released. Bind the handoff verdict back to the exact server-authored request
 * so a concurrent rebind (including ancestor fallback) can never turn another
 * Team's connected Context into a successful handoff.
 */
export function collectHandoffIdentityIssues(
  expectedProject: import("@first-tree/shared").ContextIntegrationProject,
  expectedOrganizationId: string,
  verification: Pick<ContextIntegrationStatus, "project" | "binding" | "activation">,
): string[] {
  return [
    ...(verification.project.state === "ready" && !sameProject(verification.project.project, expectedProject)
      ? ["Requested project: changed during verification"]
      : []),
    ...(verification.binding.state === "exact" && verification.binding.organizationId !== expectedOrganizationId
      ? ["Requested Team binding: changed during verification"]
      : []),
    ...(verification.activation.state === "connected" &&
    verification.activation.team.organizationId !== expectedOrganizationId
      ? ["Requested Team activation: changed during verification"]
      : []),
  ];
}

/**
 * The literal verdict line the BYO setup prompt anchors on: agents accept
 * setup only when the rendered output contains exactly `Setup: Complete`.
 */
export function renderSetupVerdictLine(setup: { complete: boolean; missingLayers: string[] }): string {
  return setup.complete
    ? "Setup: Complete — every layer verified"
    : `Setup: Incomplete — ${setup.missingLayers.join("; ")}`;
}

/**
 * Every red layer must surface an actionable recovery step; the BYO setup
 * prompt delegates all recovery to this command's output, so an Incomplete
 * verdict with no next step is a dead end.
 */
export function collectSetupRecoveryActions(
  provider: "claude-code" | "codex",
  verification: Pick<ContextIntegrationStatus, "provider" | "runtime" | "project" | "binding" | "activation">,
  binName = channelConfig.binName,
): string[] {
  const actions: string[] = [];
  if (!verification.provider.available) {
    actions.push(
      `Install the ${provider} CLI (minimum ${verification.provider.minimumVersion}), then re-run this command.`,
    );
  } else if (!verification.provider.compatible) {
    actions.push(`Upgrade ${provider} to at least ${verification.provider.minimumVersion}, then re-run this command.`);
  }
  if (!verification.runtime.healthy) {
    actions.push(
      `${verification.runtime.issues.join(" ")} Run \`${binName} context repair --provider ${provider}\`.`.trimStart(),
    );
  }
  if (verification.project.state === "unavailable") {
    actions.push(`${verification.project.message} ${verification.project.nextAction}`);
  }
  if (verification.binding.state === "missing") {
    actions.push(verification.binding.nextAction);
  } else if (verification.binding.state === "not_checked" && verification.project.state === "ready") {
    // A binding-read failure carries its diagnostic (including the config
    // path) only in `reason`; activation `not_checked` is the dependent layer
    // and needs no separate action. The config is one account-scoped store
    // for every provider and project, so recovery must stay
    // preservation-safe and never suggest deleting the file.
    actions.push(
      `${verification.binding.reason} Re-run this \`${binName} context enable\` command; if the failure persists, do not delete the binding config — it also holds bindings for other providers and projects. Back it up, then repair its file permissions or YAML together with the member before retrying.`,
    );
  }
  if (verification.activation.state === "needs_admin") {
    actions.push(
      verification.activation.message +
        (verification.activation.settingsUrl ? ` (${verification.activation.settingsUrl})` : ""),
    );
  } else if (verification.activation.state === "unavailable") {
    actions.push(`${verification.activation.message} ${verification.activation.nextAction}`);
  }
  return actions;
}

/**
 * Assemble the full Next list for an enable run. Guarantees the contract the
 * BYO setup prompt relies on: an Incomplete verdict never ships without at
 * least one next step, even for layer states with no specific recovery
 * (for example `not_checked` binding/activation variants).
 */
export function buildSetupNextActions(
  provider: "claude-code" | "codex",
  verification: Pick<ContextIntegrationStatus, "provider" | "runtime" | "hook" | "project" | "binding" | "activation">,
  setup: { complete: boolean; missingLayers: string[] },
  binName = channelConfig.binName,
  currentSessionHandoffIssue: string | null = null,
  handoffIdentityIssues: string[] = [],
): string[] {
  const actions = [
    ...collectSetupRecoveryActions(provider, verification, binName),
    ...buildContextEnableNextActions(
      provider,
      verification.hook,
      binName,
      verification.project.state === "ready" ? verification.project.project : null,
    ),
  ];
  if (currentSessionHandoffIssue) {
    actions.push(
      `Current-session handoff validation failed: ${currentSessionHandoffIssue} Run \`${binName} context repair --provider ${provider}\`, then re-run this command.`,
    );
  }
  if (handoffIdentityIssues.length > 0) {
    actions.push(
      `Final verification no longer matches this server-authored project/Team handoff (${handoffIdentityIssues.join("; ")}). Re-run the exact server-authored \`${binName} context enable\` handoff; if this repeats, stop concurrent Context setup or binding changes before retrying.`,
    );
  }
  if (!setup.complete && actions.length === 0) {
    actions.push(`Fix the layers listed in the Setup line, then re-run this \`${binName} context enable\` command.`);
  }
  return actions;
}

export function buildContextEnableNextActions(
  provider: "claude-code" | "codex",
  hook: Pick<ProviderHookProbe, "trust" | "enabled">,
  binName = channelConfig.binName,
  project: import("@first-tree/shared").ContextIntegrationProject | null = { kind: "path", root: process.cwd() },
): string[] {
  if (provider === "claude-code" || project?.kind === "pathless") {
    return [];
  }
  if (hook.trust === "trusted" && hook.enabled === true) {
    return [];
  }
  if (hook.trust === "trusted" && hook.enabled === false) {
    return [
      "Run `/hooks` in this Codex session.",
      "Find First Tree Context → SessionStart and enable its checkbox.",
      "Return to the original setup conversation and tell the agent to continue.",
      `The agent must re-run the same \`${binName} context enable\` command in this session; setup is complete only when it reports Setup: Complete.`,
    ];
  }
  return [
    "Run `/hooks` in this Codex session.",
    "Find First Tree Context → SessionStart, enable its checkbox, and choose Trust.",
    "Return to the original setup conversation and tell the agent to continue.",
    `The agent must re-run the same \`${binName} context enable\` command in this session; setup is complete only when it reports Setup: Complete.`,
  ];
}

export const contextEnableCommand: SubcommandModule = {
  name: "enable",
  alias: "",
  summary: "",
  description: "Enable First Tree Context for this project from an explicit Team handoff.",
  configure,
  action: runContextEnable,
};

function renderProject(project: import("@first-tree/shared").ContextIntegrationProject): string {
  return project.kind === "path" ? project.root : "Pathless";
}

function sameProject(
  left: import("@first-tree/shared").ContextIntegrationProject,
  right: import("@first-tree/shared").ContextIntegrationProject,
): boolean {
  return left.kind === right.kind && (left.kind === "pathless" || (right.kind === "path" && left.root === right.root));
}
