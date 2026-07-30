import { readFileSync } from "node:fs";
import { FirstTreeHubSDK } from "@first-tree/client";
import type { Command } from "commander";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import {
  activateExternalContext,
  renderProviderSessionStartResponse,
} from "../../core/context-integration/activation.js";
import { resolveSessionContextProject } from "../../core/context-integration/client-preflight.js";
import {
  contextRepairAdditionalContext,
  contextRepairCommand,
} from "../../core/context-integration/repair-guidance.js";
import { inspectContextIntegrationRuntime } from "../../core/context-integration/runtime-health.js";
import { print } from "../../core/output.js";
import { CLI_USER_AGENT } from "../../core/version.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type ActivateOptions = {
  provider?: string;
  releaseDigest?: string;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "provider hook owner")
    .requiredOption("--release-digest <digest>", "installed adapter digest");
}

export async function runContextActivate(context: CommandContext): Promise<void> {
  try {
    const options = context.command.opts<ActivateOptions>();
    const provider = parseContextProvider(options.provider ?? "");
    const health = inspectContextIntegrationRuntime(createContextIntegrationDriver(provider));
    const currentAdapterDigest = health.release?.manifest.providers[provider].adapterDigest;
    if (
      !health.healthy ||
      !health.install ||
      health.install.adapterDigest !== options.releaseDigest ||
      currentAdapterDigest !== options.releaseDigest
    ) {
      print.hook({
        continue: true,
        systemMessage: `First Tree Context unavailable: ${
          health.issues.join(" ") || "the installed hook does not match the current First Tree release."
        } Ordinary provider work can continue. Ask the current Agent to repair First Tree Context when convenient by running \`${contextRepairCommand(provider)}\`.`,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: contextRepairAdditionalContext(provider),
        },
      });
      return;
    }
    let hookInput: { cwd?: string; session_id?: string } = {};
    const input = readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("hook input is too large");
    if (input.trim()) {
      const parsed = JSON.parse(input) as { cwd?: unknown; session_id?: unknown };
      hookInput = {
        ...(typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? { cwd: parsed.cwd } : {}),
        ...(typeof parsed.session_id === "string" && parsed.session_id.length > 0
          ? { session_id: parsed.session_id }
          : {}),
      };
    }
    const resolution = resolveSessionContextProject(
      provider,
      { cwd: hookInput.cwd, sessionId: hookInput.session_id },
      process.env,
    );
    if (resolution.kind !== "path") {
      print.hook({
        continue: true,
        systemMessage:
          resolution.kind === "pathless"
            ? "First Tree Context is not auto-activated in this pathless session; use the first-tree Skill to activate it manually."
            : `First Tree Context was not auto-activated: ${resolution.message}`,
      });
      return;
    }
    const sdk = new FirstTreeHubSDK({
      serverUrl: resolveServerUrl(process.env.FIRST_TREE_SERVER_URL),
      getAccessToken: (refreshOptions) => ensureFreshAccessToken(refreshOptions),
      userAgent: CLI_USER_AGENT,
    });
    const activation = await activateExternalContext(sdk, { provider, project: resolution.project });
    print.hook(renderProviderSessionStartResponse(activation));
  } catch (error) {
    print.hook({
      continue: true,
      systemMessage: `First Tree Context unavailable: ${
        error instanceof Error ? error.message : String(error)
      }. Ordinary provider work can continue.`,
    });
  }
}

export const contextActivateCommand: SubcommandModule = {
  name: "activate",
  hidden: true,
  alias: "",
  summary: "",
  description: "Internal provider SessionStart activation bridge.",
  configure,
  action: runContextActivate,
};
