import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { enableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type EnableOptions = {
  provider?: string;
  team?: string;
  yes?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "Team from the server-authored Setup or invite handoff")
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
  const preflight = inspectContextClientPreflight();
  const activation = await createMemberSdk().validateMemberContextActivation(
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

  const result = {
    provider,
    team: activation.team,
    checkoutRoot: preflight.checkoutRoot,
    repositoryKey: preflight.repositoryKey,
    plugin: installPlan.operation,
    nextAction:
      provider === "codex"
        ? "Open Codex, review the First Tree hook in `/hooks`, then start a new session."
        : "Start a new Claude Code local session in this repository.",
  };
  if (context.options.json) print.result(result);
  else {
    print.status("Context", `Enabled for ${activation.team.displayName}`);
    print.status("Next", result.nextAction);
  }
}

export const contextEnableCommand: SubcommandModule = {
  name: "enable",
  alias: "",
  summary: "",
  description: "Enable First Tree Context for this checkout from an explicit Team handoff.",
  configure,
  action: runContextEnable,
};
