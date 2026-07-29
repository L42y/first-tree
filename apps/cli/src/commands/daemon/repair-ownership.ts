import { defaultHome } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import {
  formatDaemonRuntimeRecoveryEvidence,
  isDaemonRuntimeOwnershipError,
  repairDaemonRuntimeOwnership,
} from "../../core/daemon-runtime-ownership.js";
import { print } from "../../core/output.js";

export function registerDaemonRepairOwnershipCommand(daemon: Command): void {
  daemon
    .command("repair-ownership")
    .description("Safely reconcile an interrupted daemon ownership recovery")
    .action(() => {
      try {
        const result = repairDaemonRuntimeOwnership(defaultHome());
        if (!result.repaired) {
          print.line("  Ownership: no stale recovery fence needs repair\n");
          return;
        }
        print.line(`  Ownership: repaired ${result.lockPath}\n`);
        if (result.restoredFrom) print.line(`  Restored:  ${result.restoredFrom}\n`);
        for (const line of formatDaemonRuntimeRecoveryEvidence(result.evidence)) {
          print.line(`  Evidence:  ${line}\n`);
        }
      } catch (error) {
        if (isDaemonRuntimeOwnershipError(error)) fail(error.code, error.message, 1);
        throw error;
      }
    });
}
