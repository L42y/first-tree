import { recordRemoteBindingObservation } from "@first-tree/client";
import type { Command } from "commander";
import { readAgentContextTreeBinding } from "../../core/context-tree-binding.js";
import { LocalContextError, type LocalContextIntent, resolveLocalContext } from "../../core/local-context/index.js";
import { isJsonMode, print } from "../../core/output.js";
import { createSdkFromResolvedRuntimeAgent, resolveRuntimeLocalAgent } from "../_shared/local-agent.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import {
  localAgentMemberNodeContent,
  localContextRootNodeContent,
  localMembersIndexContent,
} from "./scaffold-templates.js";
import { verifyTreeRoot } from "./verify.js";

function parseIntent(value: unknown): LocalContextIntent {
  if (value === "read" || value === "write") return value;
  throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", "--intent must be either read or write.");
}

async function runLocalResolve(command: Command): Promise<void> {
  try {
    const options = command.opts<{ ensure?: boolean; intent?: unknown }>();
    if (options.ensure !== true) {
      throw new LocalContextError(
        "LOCAL_CONTEXT_MISSING",
        "Local Context resolution requires --ensure so an absent scaffold is repaired deterministically.",
      );
    }
    const intent = parseIntent(options.intent);
    const agent = resolveRuntimeLocalAgent();
    const sdk = createSdkFromResolvedRuntimeAgent(agent);
    const result = await resolveLocalContext(
      {
        agentId: agent.agentId,
        agentName: agent.agentName,
        cwd: process.cwd(),
        ensure: true,
        intent,
        scaffold: {
          memberNode: localAgentMemberNodeContent(agent.agentName),
          membersIndex: localMembersIndexContent(agent.agentName),
          rootNode: localContextRootNodeContent(agent.agentName),
        },
        serverUrl: agent.serverUrl,
        workspaceRoot: agent.workspaceRoot,
      },
      {
        readBinding: async () => {
          const binding = await readAgentContextTreeBinding(sdk, { agent: agent.agentName });
          return binding.status === "bound"
            ? { status: "bound", branch: binding.branch, repoUrl: binding.repo }
            : { status: binding.status };
        },
        recordRemoteBinding: (binding) =>
          recordRemoteBindingObservation(agent.workspaceRoot, {
            repoUrl: binding.repoUrl,
            branch: binding.branch,
          }),
        verifyTree: verifyTreeRoot,
      },
    );

    if (isJsonMode()) {
      print.result(result);
      return;
    }
    print.line(
      `  Local Context: ${result.path}\n` +
        `  Agent: ${result.agentName} (${result.agentId})\n` +
        `  State: ${result.verified ? "verified" : "repair-only"}\n`,
    );
  } catch (error) {
    if (error instanceof LocalContextError) {
      print.fail(error.code, error.message, error.code.includes("BINDING") ? 6 : 1);
    }
    const message = error instanceof Error ? error.message : String(error);
    print.fail("LOCAL_CONTEXT_RESOLVE_FAILED", message);
  }
}

function configureTreeLocalCommand(command: Command): void {
  command.helpCommand(false).allowExcessArguments(false);
  const resolveCommand = command
    .command("resolve")
    .description("Resolve and validate the active Agent Workspace Local Context root.")
    .requiredOption("--intent <read|write>", "operation intent used for invalid-tree handling")
    .option("--ensure", "create or mechanically repair the minimal Local Context scaffold")
    .allowExcessArguments(false)
    .action(() => runLocalResolve(resolveCommand));
}

function runTreeLocalGroup(context: CommandContext): void {
  context.command.outputHelp();
}

export const treeLocalCommand: SubcommandModule = {
  name: "local",
  alias: "",
  summary: "",
  description: "Resolve Agent-private Local Context runtime state.",
  action: runTreeLocalGroup,
  configure: configureTreeLocalCommand,
};
