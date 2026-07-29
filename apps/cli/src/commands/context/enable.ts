import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { enableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import type { ProviderHookProbe } from "../../core/context-integration/provider-driver.js";
import { inspectContextIntegrationStatus } from "../../core/context-integration/status.js";
import { print } from "../../core/output.js";
import { getClientServiceStatus, isServiceSupported } from "../../core/service-install.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";
import { renderHookEnabled, renderHookTrust } from "./status.js";

type EnableOptions = {
  provider?: string;
  team?: string;
  yes?: boolean;
  completeOnboarding?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "Team from the server-authored Setup or invite handoff")
    .option("--yes", "accept the displayed local Plugin/binding change plan")
    .option(
      "--complete-onboarding",
      "finish this Team membership's onboarding after local and live Context verification",
    );
}

export async function runContextEnable(context: CommandContext): Promise<void> {
  const options = context.command.opts<EnableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const teamId = options.team?.trim() ?? "";
  if (!teamId) {
    print.fail("CONTEXT_TEAM_REQUIRED", "--team must contain the explicit handoff Team id.", 2);
  }
  const expectedAccountClientId = readActiveContextAccountClientId();
  const preflight = inspectContextClientPreflight();
  const sdk = createMemberSdk();
  const activation = await sdk.validateMemberContextActivation(
    teamId,
    {
      schemaVersion: 1,
      repositoryKey: preflight.repositoryKey,
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
  const expectedConfig = readContextIntegrationConfig();
  const previousBinding = findContextBinding(provider, preflight.checkoutRoot);
  print.status("Provider", provider);
  print.status("Plugin", installPlan.operation);
  print.status("Repository", preflight.repositoryKey);
  print.status("Team binding", previousBinding ? `${previousBinding.organizationId} → ${teamId}` : `add ${teamId}`);

  const accepted =
    options.yes === true ||
    (!context.options.json &&
      (await confirm({
        message: "Apply this user-scope Plugin and exact checkout binding change?",
        default: true,
      })));
  if (!accepted) print.fail("CONTEXT_ENABLE_CANCELLED", "No changes were applied.", 2);

  enableContextIntegrationOperation(
    driver,
    installPlan,
    {
      provider,
      checkoutRoot: preflight.checkoutRoot,
      repositoryKey: preflight.repositoryKey,
      organizationId: teamId,
    },
    expectedConfig,
    expectedAccountClientId,
  );

  const verification = await inspectContextIntegrationStatus(driver, sdk, preflight.checkoutRoot);
  const nextActions = buildContextEnableNextActions(provider, verification.hook);
  let onboardingCompleted = false;
  if (options.completeOnboarding) {
    const completionIssues = await contextOnboardingCompletionIssues({
      teamId,
      repositoryKey: preflight.repositoryKey,
      clientId: expectedAccountClientId,
      verification,
      getClientStatus: (clientId) => sdk.getOwnedClientStatus(clientId),
    });
    if (completionIssues.length > 0) {
      print.fail(
        "CONTEXT_ONBOARDING_VERIFICATION_PENDING",
        `First Tree Context was enabled, but onboarding is still waiting for: ${completionIssues.join(" ")}`,
        1,
      );
    }
    await sdk.completeMemberOnboarding(teamId);
    onboardingCompleted = true;
  }

  const result = {
    provider,
    team: activation.team,
    checkoutRoot: preflight.checkoutRoot,
    repositoryKey: preflight.repositoryKey,
    plugin: installPlan.operation,
    verification,
    nextActions,
    onboardingCompleted,
  };
  if (context.options.json) print.result(result);
  else {
    print.status("Context", `Enabled for ${activation.team.displayName}`);
    print.status("Plugin installed", verification.plugin.installed ? "Yes" : "No");
    print.status("Plugin enabled", verification.plugin.enabled ? "Yes" : "No");
    print.status("Hook trusted", renderHookTrust(verification.hook));
    print.status("Hook enabled", renderHookEnabled(verification.hook));
    print.status(
      "Exact binding",
      verification.binding.state === "exact"
        ? `Yes — Team ${verification.binding.organizationId}`
        : `No — ${verification.binding.state}`,
    );
    print.status(
      "Live activation",
      verification.activation.state === "connected"
        ? `Connected — ${verification.activation.team.displayName}`
        : verification.activation.state,
    );
    nextActions.forEach((action, index) => {
      print.status(`Next ${index + 1}`, action);
    });
    if (onboardingCompleted) print.status("Onboarding", "Complete");
  }
}

type OnboardingVerification = Awaited<ReturnType<typeof inspectContextIntegrationStatus>>;

export async function contextOnboardingCompletionIssues(input: {
  teamId: string;
  repositoryKey: string;
  clientId: string;
  verification: OnboardingVerification;
  getClientStatus: (clientId: string) => Promise<{ status: "connected" | "disconnected" }>;
}): Promise<string[]> {
  const issues: string[] = [];
  const { verification } = input;

  if (!verification.provider.compatible || !verification.plugin.installed || !verification.plugin.enabled) {
    issues.push("a compatible, installed, and enabled First Tree Context Plugin.");
  }
  if (!verification.runtime.healthy) {
    issues.push("a healthy local Context Plugin payload.");
  }
  const hookReady =
    verification.hook.enabled === true &&
    (verification.hook.trust === "trusted" || verification.hook.trust === "provider_managed");
  if (!hookReady) {
    issues.push("the provider Hook to be enabled and trusted.");
  }
  if (
    verification.binding.state !== "exact" ||
    verification.binding.organizationId !== input.teamId ||
    verification.binding.repositoryKey !== input.repositoryKey
  ) {
    issues.push("the exact checkout-to-Team binding.");
  }
  if (verification.activation.state !== "connected" || verification.activation.team.organizationId !== input.teamId) {
    issues.push("live Team Context activation.");
  }
  if (isServiceSupported() && getClientServiceStatus().state !== "active") {
    issues.push("the First Tree background service to be running.");
  }
  try {
    const client = await input.getClientStatus(input.clientId);
    if (client.status !== "connected") {
      issues.push("this Computer to be connected to First Tree.");
    }
  } catch {
    issues.push("this Computer's live connection to be verified.");
  }
  return issues;
}

export function buildContextEnableNextActions(
  provider: "claude-code" | "codex",
  hook: Pick<ProviderHookProbe, "trust" | "enabled">,
  binName = channelConfig.binName,
): string[] {
  if (provider === "claude-code") {
    return ["Start a new Claude Code local session in this repository."];
  }
  if (hook.trust === "trusted" && hook.enabled === true) {
    return [
      "Start a new Codex session in this checkout so SessionStart can connect Context.",
      `Run \`${binName} context status --provider codex\` to verify every layer remains connected.`,
    ];
  }
  if (hook.trust === "trusted" && hook.enabled === false) {
    return [
      "Open Codex in this checkout.",
      "Run `/hooks`.",
      "Find First Tree Context → SessionStart and enable its checkbox.",
      "Exit and start a new Codex session in this checkout.",
      `Run \`${binName} context status --provider codex\`; confirm Hook trusted/enabled are Yes and Live activation is Connected.`,
    ];
  }
  return [
    "Open Codex in this checkout.",
    "Run `/hooks`.",
    "Find First Tree Context → SessionStart, enable its checkbox, and choose Trust.",
    "Exit and start a new Codex session in this checkout.",
    `Run \`${binName} context status --provider codex\`; confirm Hook trusted/enabled are Yes and Live activation is Connected.`,
  ];
}

export const contextEnableCommand: SubcommandModule = {
  name: "enable",
  alias: "",
  summary: "",
  description: "Enable First Tree Context for this checkout from an explicit Team handoff.",
  configure,
  action: runContextEnable,
};
