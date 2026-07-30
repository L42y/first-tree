import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import { readContextIntegrationConfig } from "../../core/context-integration/context-binding-store.js";
import { contextIntegrationMarketplaceName } from "../../core/context-integration/installer.js";
import { readContextIntegrationInstallManifest } from "../../core/context-integration/manifest.js";
import { disableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type DisableOptions = {
  provider?: string;
  all?: boolean;
  yes?: boolean;
  projectRoot?: string;
  pathless?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .option("--all", "remove every binding for this provider")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "remove the provider's pathless project binding")
    .option("--yes", "accept the displayed cleanup plan");
}

export async function runContextDisable(context: CommandContext): Promise<void> {
  const options = context.command.opts<DisableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const expectedAccountClientId = readActiveContextAccountClientId();
  const driver = createContextIntegrationDriver(provider);
  const install = readContextIntegrationInstallManifest(provider);
  const marketplaceName = install?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginPresent = install !== null || driver.probe(marketplaceName, "first-tree-context").installed;
  const project =
    options.all === true
      ? undefined
      : inspectContextClientPreflight(provider, {
          projectRoot: options.projectRoot,
          pathless: options.pathless,
        }).project;
  const config = readContextIntegrationConfig();
  const existing = config.bindings.filter(
    (binding) =>
      binding.provider === provider &&
      (options.all === true || (project && JSON.stringify(binding.project) === JSON.stringify(project))),
  );
  if (existing.length === 0 && (options.all !== true || !pluginPresent)) {
    if (context.options.json) print.result({ provider, removed: [], pluginRemoved: false });
    else print.status("Context", "No matching binding");
    return;
  }
  const remainingCount = config.bindings.filter(
    (binding) => binding.provider === provider && !existing.includes(binding),
  ).length;
  print.status("Bindings", `remove ${existing.length}`);
  print.status("Plugin", remainingCount === 0 ? "remove First Tree-owned Plugin" : "keep");
  const accepted =
    options.yes === true ||
    (!context.options.json && (await confirm({ message: "Apply this Context disable plan?", default: false })));
  if (!accepted) print.fail("CONTEXT_DISABLE_CANCELLED", "No changes were applied.", 2);

  const result = disableContextIntegrationOperation(driver, {
    all: options.all === true,
    project,
    removePlugin: remainingCount === 0 && pluginPresent,
    expectedConfig: config,
    expectedAccountClientId,
  });
  const output = { provider, removed: result.removed, pluginRemoved: result.pluginRemoved };
  if (context.options.json) print.result(output);
  else print.status("Context", "Disabled");
}

export const contextDisableCommand: SubcommandModule = {
  name: "disable",
  alias: "",
  summary: "",
  description: "Disable First Tree Context for this project or provider.",
  configure,
  action: runContextDisable,
};
