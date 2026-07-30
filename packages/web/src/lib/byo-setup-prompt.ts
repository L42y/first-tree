import type { ContextEnablementHandoff, ContextIntegrationProvider } from "@first-tree/shared";

export type ByoSetupPromptIntent = "onboarding" | "settings";

type ByoSetupPromptBase = {
  organizationId: string;
  bootstrapCommand: string;
};

export type BuildByoSetupPromptOptions =
  | (ByoSetupPromptBase & {
      intent: "onboarding";
      handoffs: readonly [ContextEnablementHandoff] | readonly [ContextEnablementHandoff, ContextEnablementHandoff];
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
  const commandInstructions = [
    "Detect the coding-agent host you are currently running in. Use the Codex command for Codex App or CLI, or the Claude Code command for Claude Code. Do not infer the host from installed binaries, and do not run both commands.",
    "",
    ...handoffs.flatMap((handoff, index) => [
      `If you are ${PROVIDER_LABELS[handoff.provider]}:`,
      handoff.command,
      ...(index === handoffs.length - 1 ? [] : [""]),
    ]),
    "",
    "Run the selected handoff command exactly as written. Do not append a project selector: the First Tree CLI resolves this provider's attached or pathless project through its provider-specific resolver.",
  ];
  const completion =
    intent === "onboarding"
      ? "Only tell me setup is ready after that. First Tree Web owns onboarding completion separately."
      : "Do not mark onboarding complete. First Tree verifies completion separately.";

  return [
    `Set up First Tree Team Context for this coding-agent project in ${target}.`,
    "",
    "Complete the whole setup inside this coding-agent session. Do not ask me to open Terminal. Setup is user-scoped: do not modify project files — Team Context does not live in the source repositories.",
    "",
    "First run this server-provided bootstrap. It installs or updates First Tree and signs this computer in, and every step is safe to re-run:",
    "",
    bootstrapCommand,
    "",
    "If the login step fails because its code is expired or already used, stop and ask me for a fresh setup prompt from First Tree Settings — never reuse an old code. If login reports this computer is signed in as a different First Tree user, stop and ask me before any switch; that check consumes the code, so if I approve the switch, ask me for a fresh setup prompt and run its login line with `--force-switch` appended.",
    "",
    ...commandInstructions,
    "",
    `Target Team ID: ${organizationId}`,
    "",
    "The local project is only a routing boundary. Do not inspect Git remotes, require a repository root, or register source repositories with First Tree.",
    ...(providers.has("codex")
      ? [
          "",
          "For an attached Codex project, if Codex requires First Tree hook approval, guide me through /hooks and continue verification. A pathless project uses manual activation and does not require hook trust for setup to be complete.",
        ]
      : []),
    "",
    `The enable command verifies the whole setup and its output tells you what to do — follow it exactly. Setup is successful only when the enable command reports "Setup: Complete"; if it reports Incomplete, finish its Next steps and re-run the same enable command until it does. ${completion}`,
  ].join("\n");
}
