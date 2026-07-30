import type { Command } from "commander";
import {
  ExternalContextActivationRequiredError,
  requireConnectedExternalContext,
} from "../../core/context-integration/activation.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import { contextRepairUnavailableMessage } from "../../core/context-integration/repair-guidance.js";
import { inspectContextIntegrationRuntime } from "../../core/context-integration/runtime-health.js";
import { ContextTreeWritePreflightCliError, preflightContextTreeWrite } from "../../core/context-tree-write.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type ContextWriteOptions = {
  provider?: string;
  snapshot?: string;
  githubLogin?: string;
  projectRoot?: string;
  pathless?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "provider Plugin owner")
    .requiredOption("--snapshot <directory>", "exact snapshot created by the external Context Read route")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "use the provider's explicit pathless project binding")
    .option("--github-login <login>", "current local gh login for a GitHub PR author");
}

export async function runContextWrite(context: CommandContext): Promise<void> {
  const options = context.command.opts<ContextWriteOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const health = inspectContextIntegrationRuntime(createContextIntegrationDriver(provider));
  if (!health.healthy) {
    print.fail("context_plugin_repair_required", contextRepairUnavailableMessage(provider, health.issues), 1);
  }
  const sdk = createMemberSdk();
  try {
    const activation = await requireConnectedExternalContext(sdk, {
      provider,
      project: inspectContextClientPreflight(provider, {
        projectRoot: options.projectRoot,
        pathless: options.pathless,
      }).project,
    });
    const preflight = await preflightContextTreeWrite(
      {
        preflightMemberContextTreeWrite(teamId, request, callOptions): Promise<unknown> {
          return sdk.preflightMemberContextTreeWrite(teamId, request, callOptions);
        },
      },
      {
        teamId: activation.team.organizationId,
        snapshotPath: options.snapshot ?? "",
        ...(options.githubLogin ? { requesterGithubLogin: options.githubLogin } : {}),
      },
    );
    if (context.options.json || isJsonMode()) {
      print.result(preflight);
      return;
    }
    print.status("Team", `${activation.team.displayName} (${preflight.teamId})`);
    print.status("Provider", preflight.provider);
    print.status("Binding", `${preflight.binding.repo}#${preflight.binding.branch}`);
    print.status("Exact base", preflight.baseCommit);
    print.status("Snapshot", preflight.snapshotPath);
    print.status("Current Reviewer", preflight.reviewerAgentUuid);
  } catch (error) {
    if (error instanceof ExternalContextActivationRequiredError) {
      print.fail(error.reasonCode, error.message, 1, { status: error.outcome });
    }
    if (error instanceof ContextTreeWritePreflightCliError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const contextWriteCommand: SubcommandModule = {
  name: "write",
  hidden: true,
  alias: "",
  summary: "",
  description: "Internal external-Plugin Write route with project activation.",
  configure,
  action: runContextWrite,
};
