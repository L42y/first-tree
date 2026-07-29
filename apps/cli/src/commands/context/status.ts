import type { Command } from "commander";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import { findContextBinding } from "../../core/context-integration/context-binding-store.js";
import { readContextIntegrationInstallJournal } from "../../core/context-integration/installer.js";
import { inspectContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { inspectContextIntegrationRuntime } from "../../core/context-integration/runtime-health.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

function configure(command: Command): void {
  command.requiredOption("--provider <provider>", "claude-code or codex");
}

export async function runContextStatus(context: CommandContext): Promise<void> {
  const provider = parseContextProvider(context.command.opts<{ provider?: string }>().provider ?? "");
  const driver = createContextIntegrationDriver(provider);
  const health = inspectContextIntegrationRuntime(driver);
  const install = health.install;
  const incompleteInstall = readContextIntegrationInstallJournal();
  const incompleteOperation = inspectContextIntegrationOperation();
  const probe = health.probe;
  let checkout:
    | {
        root: string;
        repositoryKey: string;
        binding: ReturnType<typeof findContextBinding>;
        activation?: unknown;
      }
    | undefined;
  try {
    const preflight = inspectContextClientPreflight();
    const binding = findContextBinding(provider, preflight.checkoutRoot);
    checkout = {
      root: preflight.checkoutRoot,
      repositoryKey: preflight.repositoryKey,
      binding,
    };
    if (health.healthy && binding && binding.repositoryKey === preflight.repositoryKey) {
      checkout.activation = await createMemberSdk().validateMemberContextActivation(
        binding.organizationId,
        {
          schemaVersion: 1,
          repositoryKey: binding.repositoryKey,
        },
        { retry: false, timeoutMs: 2_000 },
      );
    }
  } catch {
    // Provider status remains useful outside a Git checkout or while signed out.
  }
  const result = { provider, health, install, incompleteInstall, incompleteOperation, probe, checkout };
  if (context.options.json) print.result(result);
  else {
    print.status("Provider", probe.binaryAvailable ? (probe.version ?? "Available") : "Missing");
    print.status("Plugin", probe.installed ? (probe.enabled ? "Enabled" : "Disabled") : "Not installed");
    print.status("Release", health.healthy ? "Healthy" : "Repair required");
    for (const issue of health.issues) print.status("Issue", issue);
    if (incompleteInstall?.provider === provider) {
      print.status("Recovery", `Incomplete ${incompleteInstall.phase}; run context repair`);
    }
    if (incompleteOperation?.provider === provider) {
      print.status(
        "Recovery",
        `Incomplete ${incompleteOperation.operation}/${incompleteOperation.phase}; run context repair`,
      );
    }
    print.status("Checkout", checkout?.root ?? "Not a signed-in Git checkout");
    print.status("Team binding", checkout?.binding?.organizationId ?? "None");
    if (probe.hookTrust === "review_required") {
      print.status("Hook trust", "Review in Codex `/hooks`");
    }
  }
}

export const contextStatusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Inspect the local Context Plugin, binding, and live Team activation.",
  configure,
  action: runContextStatus,
};
