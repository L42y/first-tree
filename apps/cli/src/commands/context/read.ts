import type { Command } from "commander";
import {
  ExternalContextActivationRequiredError,
  requireConnectedExternalContext,
} from "../../core/context-integration/activation.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import { contextRepairCommand } from "../../core/context-integration/repair-guidance.js";
import { inspectContextIntegrationRuntime } from "../../core/context-integration/runtime-health.js";
import { activateContextTreeRead, ContextTreeReadActivationError } from "../../core/context-tree-read.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type ContextReadOptions = {
  provider?: string;
  snapshot?: string;
  projectRoot?: string;
  pathless?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "provider Plugin owner")
    .requiredOption("--snapshot <directory>", "new task-owned exact Context Tree snapshot directory")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "use the provider's explicit pathless project binding");
}

export async function runContextRead(context: CommandContext): Promise<void> {
  const options = context.command.opts<ContextReadOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const health = inspectContextIntegrationRuntime(createContextIntegrationDriver(provider));
  if (!health.healthy) {
    print.fail(
      "context_plugin_repair_required",
      `${health.issues.join(" ")} Run \`${contextRepairCommand(provider)}\`.`,
      1,
    );
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
    const snapshot = await activateContextTreeRead(
      {
        getMemberContextTreeSetting(teamId, callOptions): Promise<unknown> {
          return sdk.getMemberContextTreeSetting(teamId, callOptions);
        },
      },
      {
        teamId: activation.team.organizationId,
        snapshotPath: options.snapshot ?? "",
      },
    );
    if (context.options.json || isJsonMode()) {
      print.result(snapshot);
      return;
    }
    print.status("Team", `${activation.team.displayName} (${snapshot.teamId})`);
    print.status("Provider", snapshot.binding.provider ?? "legacy/unresolved");
    print.status("Binding", `${snapshot.binding.repo}#${snapshot.binding.branch}`);
    print.status("Exact commit", snapshot.commit);
    print.status("Snapshot", snapshot.snapshotPath);
  } catch (error) {
    if (error instanceof ExternalContextActivationRequiredError) {
      print.fail(error.reasonCode, error.message, 1, { status: error.outcome });
    }
    if (error instanceof ContextTreeReadActivationError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const contextReadCommand: SubcommandModule = {
  name: "read",
  hidden: true,
  alias: "",
  summary: "",
  description: "Internal external-Plugin Read route with project activation.",
  configure,
  action: runContextRead,
};
