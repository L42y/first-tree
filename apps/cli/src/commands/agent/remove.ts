import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir, defaultDataDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { localContextDataLossForAgent, removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      const agentDir = join(defaultConfigDir(), "agents", name);
      if (!existsSync(agentDir)) {
        print.line(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      const localContext = localContextDataLossForAgent(join(defaultDataDir(), "workspaces"), name);
      if (localContext) {
        print.line(
          `  Warning: removing Agent "${name}" permanently deletes its unmigrated Local Context at ${localContext.path}.\n`,
        );
      }
      removeLocalAgent(name);
      print.line(`  Agent "${name}" removed.\n`);
    });
}
