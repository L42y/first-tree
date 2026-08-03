import type { ContextPersistentActivationScope } from "@first-tree/shared";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { readContextIntegrationConfig } from "../../core/context-integration/context-binding-store.js";
import { disableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { parseContextProvider } from "./shared.js";

type DisableOptions = {
  provider?: string;
  team?: string;
  scope?: string;
  directoryRoot?: string;
  yes?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "exact Team grant to remove")
    .requiredOption("--scope <scope>", "global or directory")
    .option("--directory-root <directory>", "exact canonical directory grant root")
    .option("--yes", "accept the displayed grant removal");
}

export async function runContextDisable(context: CommandContext): Promise<void> {
  const options = context.command.opts<DisableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const teamId = options.team?.trim() ?? "";
  if (!teamId) print.fail("CONTEXT_TEAM_REQUIRED", "--team is required.", 2);
  const activationScope = parsePersistentScope(options);
  const config = readContextIntegrationConfig();
  const present = config.grants.some(
    (grant) =>
      grant.provider === provider &&
      grant.organizationId === teamId &&
      JSON.stringify(grant.activationScope) === JSON.stringify(activationScope),
  );
  if (!present) {
    const result = { provider, organizationId: teamId, activationScope, status: "already_disabled" };
    if (context.options.json) print.result(result);
    else print.status("Context grant", "Already disabled");
    return;
  }
  print.status("Provider", provider);
  print.status("Team", teamId);
  print.status("Scope", activationScope.kind === "directory" ? activationScope.root : "global");
  print.status("Plugin", "Keep the shared user-scope Plugin");
  const accepted =
    options.yes === true ||
    (!context.options.json && (await confirm({ message: "Remove exactly this Team grant?", default: false })));
  if (!accepted) print.fail("CONTEXT_DISABLE_CANCELLED", "No changes were applied.", 2);
  const removed = disableContextIntegrationOperation(provider, {
    organizationId: teamId,
    activationScope,
    expectedConfig: config,
    expectedAccountClientId: readActiveContextAccountClientId(),
  });
  const result = { provider, organizationId: teamId, activationScope, status: "disabled", removed: removed.removed };
  if (context.options.json) print.result(result);
  else {
    print.status("Context", "Grant removed for future routing");
    print.status("Current session", "Already-read Team content cannot be removed from model memory");
  }
}

function parsePersistentScope(options: DisableOptions): ContextPersistentActivationScope {
  if (options.scope === "global") return { kind: "global" };
  if (options.scope === "directory" && options.directoryRoot) {
    return { kind: "directory", root: options.directoryRoot };
  }
  print.fail(
    "CONTEXT_SCOPE_INVALID",
    "--scope must be global or directory; directory also requires --directory-root with the exact displayed root.",
    2,
  );
  throw new Error("unreachable");
}

export const contextDisableCommand: SubcommandModule = {
  name: "disable",
  alias: "",
  summary: "",
  description: "Remove one exact persistent BYO Team grant.",
  configure,
  action: runContextDisable,
};
