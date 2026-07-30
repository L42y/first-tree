import type { ContextIntegrationProvider } from "@first-tree/shared";
import { channelConfig } from "../channel.js";

export function contextRepairCommand(provider: ContextIntegrationProvider): string {
  return `${channelConfig.binName} context repair --provider ${provider}`;
}

export function contextRepairAdditionalContext(provider: ContextIntegrationProvider): string {
  const command = contextRepairCommand(provider);
  return [
    "First Tree Context is unavailable because the installed Plugin does not match this First Tree release.",
    "Ordinary provider work can continue without First Tree Context.",
    "Do not repair, upgrade, or synchronize the Plugin automatically.",
    `Only if the user explicitly asks to repair, upgrade, or synchronize First Tree Context, run \`${command}\`.`,
    `After repair, run \`${channelConfig.binName} context status --provider ${provider}\`; manually activate First Tree Context if the current session still needs it.`,
  ].join("\n");
}

export function contextRepairUnavailableMessage(
  provider: ContextIntegrationProvider,
  issues: readonly string[],
): string {
  return [issues.join(" "), contextRepairAdditionalContext(provider)].filter(Boolean).join("\n");
}
