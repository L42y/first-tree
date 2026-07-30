import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import { disableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { print } from "../../core/output.js";
import { shellQuote } from "../../core/supervisor/shared.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { parseContextProvider } from "./shared.js";

type DisableOptions = {
  provider?: string;
  yes?: boolean;
  projectRoot?: string;
  pathless?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "remove the provider's pathless project binding")
    .option("--yes", "accept the displayed cleanup plan");
}

export async function runContextDisable(context: CommandContext): Promise<void> {
  const options = context.command.opts<DisableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const expectedAccountClientId = readActiveContextAccountClientId();
  const project = inspectContextClientPreflight(provider, {
    projectRoot: options.projectRoot,
    pathless: options.pathless,
  }).project;
  const config = readContextIntegrationConfig();
  const effectiveBinding = findContextBinding(provider, project);
  if (!effectiveBinding) {
    if (context.options.json) print.result({ provider, project, status: "already_disabled", removed: null });
    else print.status("Context", "Already disabled");
    return;
  }
  print.status("Project", effectiveBinding.project.kind === "path" ? effectiveBinding.project.root : "pathless");
  print.status("Team", effectiveBinding.organizationId);
  print.status("Plugin", "keep user-scope Plugin");
  const accepted =
    options.yes === true ||
    (!context.options.json && (await confirm({ message: "Disable Context for this Project?", default: false })));
  if (!accepted) print.fail("CONTEXT_DISABLE_CANCELLED", "No changes were applied.", 2);

  const result = disableContextIntegrationOperation(provider, {
    project: effectiveBinding.project,
    expectedConfig: config,
    expectedAccountClientId,
  });
  const fallback = findContextBinding(provider, project);
  const output = {
    provider,
    project,
    status: fallback ? "fallback_active" : "disabled",
    removed: result.removed[0] ?? null,
    fallback,
  };
  if (context.options.json) print.result(output);
  else if (fallback) {
    print.status(
      "Context",
      `Removed the deepest binding, but parent Project ${fallback.project.kind === "path" ? fallback.project.root : "pathless"} remains active for Team ${fallback.organizationId}`,
    );
    print.status(
      "Next action",
      `${channelConfig.binName} context disable --provider ${provider} ${
        project.kind === "path" ? `--project-root ${shellQuote(project.root)}` : "--pathless"
      }`,
    );
    print.status("Current session", "already injected Context cannot be removed");
  } else {
    print.status("Context", "Disabled for future sessions and activations");
    print.status("Current session", "already injected Context cannot be removed");
  }
}

export const contextDisableCommand: SubcommandModule = {
  name: "disable",
  alias: "",
  summary: "",
  description: "Disable First Tree Context for the current project.",
  configure,
  action: runContextDisable,
};
