import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  ContextReloadReceiptError,
  inspectContextAdapterLoadedObservationObligation,
  issueContextAdapterSessionLoadedReceipt,
} from "../../core/context-integration/adapter-observation.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { parseContextProvider } from "./shared.js";

type Options = { provider?: string; adapterDigest?: string; adoptionGeneration?: string };

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>")
    .requiredOption("--adapter-digest <digest>")
    .requiredOption("--adoption-generation <generation>");
}

export function runContextObserveLoaded(
  context: CommandContext,
  dependencies: {
    inspectObligation?: typeof inspectContextAdapterLoadedObservationObligation;
    issueReceipt?: typeof issueContextAdapterSessionLoadedReceipt;
  } = {},
): void {
  const options = context.command.opts<Options>();
  const provider = parseContextProvider(options.provider ?? "");
  try {
    const identity = {
      provider,
      adapterDigest: options.adapterDigest ?? "",
      adoptionGeneration: options.adoptionGeneration ?? "",
    };
    const obligation = (dependencies.inspectObligation ?? inspectContextAdapterLoadedObservationObligation)(identity);
    if (obligation === null) {
      print.hook({ continue: true });
      return;
    }
    const input = readHookInput();
    const receipt = (dependencies.issueReceipt ?? issueContextAdapterSessionLoadedReceipt)({
      ...identity,
      sessionId: input.session_id,
    });
    if (receipt === null) {
      print.hook({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "First Tree Context repair was adopted by this Claude session.",
        },
      });
      return;
    }
    print.hook({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          "First Tree Context is loaded for this Claude session.",
          `When rerunning an exact pending First Tree setup apply, append --reload-receipt '${receipt}'.`,
          "Treat this opaque receipt as session-local. Do not display it, reuse it, or attach it to another plan.",
        ].join("\n"),
      },
    });
  } catch {
    // An old compatible hook continues to run until Claude reloads the
    // Plugin. A target mismatch or missing host session identity therefore
    // leaves any pending setup incomplete without turning routine forward
    // updates into user-visible failures.
    print.hook({ continue: true });
  }
}

function readHookInput(): { session_id: string } {
  const raw = readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) throw new ContextReloadReceiptError("Hook input is too large.");
  const value = JSON.parse(raw) as { session_id?: unknown };
  if (typeof value.session_id !== "string" || !value.session_id) {
    throw new ContextReloadReceiptError("Claude did not provide a trustworthy session identity.");
  }
  return { session_id: value.session_id };
}

export const contextObserveLoadedCommand: SubcommandModule = {
  name: "observe-loaded",
  hidden: true,
  alias: "",
  summary: "",
  description: "Internal Claude lifecycle bridge for a session-loaded adapter receipt.",
  configure,
  action: runContextObserveLoaded,
};
