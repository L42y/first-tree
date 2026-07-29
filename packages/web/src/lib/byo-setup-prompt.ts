import type { ContextEnablementHandoff, ContextIntegrationProvider } from "@first-tree/shared";

export type ByoSetupPromptIntent = "onboarding" | "settings";

type ByoSetupPromptBase = {
  organizationId: string;
  bootstrapCommand: string;
};

export type BuildByoSetupPromptOptions =
  | (ByoSetupPromptBase & {
      intent: "onboarding";
      handoffs: readonly [ContextEnablementHandoff];
    })
  | (ByoSetupPromptBase & {
      intent: "settings";
      handoffs: readonly [ContextEnablementHandoff, ContextEnablementHandoff];
    });

const PROVIDER_LABELS: Record<ContextIntegrationProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Builds the single self-contained artifact shared by Member onboarding and
 * Settings. The Server remains authoritative for both the short-lived machine
 * bootstrap and each exact-Team provider command; this renderer adds no flags
 * and never asks the user to assemble the steps themselves.
 */
export function buildByoSetupPrompt({
  organizationId,
  bootstrapCommand,
  handoffs,
  intent,
}: BuildByoSetupPromptOptions): string {
  if (!bootstrapCommand.trim()) {
    throw new Error("BYO setup requires a server-authored bootstrap command");
  }
  const providers = new Set<ContextIntegrationProvider>();
  for (const handoff of handoffs) {
    if (handoff.organizationId !== organizationId || !handoff.command.trim()) {
      throw new Error("BYO setup handoffs must describe the expected Team and provider");
    }
    if (providers.has(handoff.provider)) {
      throw new Error("BYO setup cannot contain duplicate provider handoffs");
    }
    providers.add(handoff.provider);
  }
  if (intent === "settings" && (!providers.has("claude-code") || !providers.has("codex"))) {
    throw new Error("Settings BYO setup requires one handoff for each supported provider");
  }

  const providerNames = handoffs.map((handoff) => PROVIDER_LABELS[handoff.provider]);
  const target =
    providerNames.length === 1
      ? providerNames[0]
      : `${providerNames.slice(0, -1).join(", ")} or ${providerNames.at(-1)}`;
  const commandInstructions =
    handoffs.length === 1
      ? [
          `Then enable Team Context for this exact repository checkout with the server-provided ${providerNames[0]} command:`,
          "",
          handoffs[0]?.command ?? "",
        ]
      : [
          "Then use exactly one of these server-provided commands, matching the coding agent you are currently running in. Do not run both and do not add, remove, or change command flags.",
          "",
          ...handoffs.flatMap((handoff, index) => [
            `If you are ${PROVIDER_LABELS[handoff.provider]}:`,
            handoff.command,
            ...(index === handoffs.length - 1 ? [] : [""]),
          ]),
        ];
  const completion =
    intent === "onboarding"
      ? "Only tell me setup is ready after First Tree verifies the provider integration, the exact-checkout Team binding, and live Team Context activation, and confirms that onboarding is complete."
      : "After First Tree verifies the provider integration, the exact-checkout Team binding, and live Team Context activation, tell me the exact next step for starting a fresh coding-agent session. Do not mark onboarding complete.";

  return [
    `Set up First Tree Team Context for this repository in ${target}.`,
    "",
    "Complete the whole setup inside this coding-agent session. Do not ask me to open Terminal.",
    "",
    "First inspect this machine locally. If First Tree is missing or this computer is not signed in to my First Tree account, use this server-provided bootstrap:",
    "",
    bootstrapCommand,
    "",
    ...commandInstructions,
    "",
    `Target Team ID: ${organizationId}`,
    "",
    "Run the enable command from this repository's root. If this session is not at the repository root, stop and tell me where to reopen it. If First Tree detects a different local account, ask me before switching. Do not create a First Tree agent or open First Tree Chat, and do not modify repository files.",
    ...(providers.has("codex")
      ? [
          "",
          "If Codex requires First Tree hook approval, guide me through /hooks in Codex and then continue verification. Do not report success before the hook is trusted.",
        ]
      : []),
    "",
    completion,
  ].join("\n");
}
