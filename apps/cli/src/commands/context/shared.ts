import { type ContextIntegrationProvider, contextIntegrationProviderSchema } from "@first-tree/shared";
import type { ContextIntegrationProviderDriver } from "../../core/context-integration/provider-driver.js";
import { ClaudeCodeContextIntegrationDriver } from "../../core/context-integration/providers/claude-code.js";
import { CodexContextIntegrationDriver } from "../../core/context-integration/providers/codex.js";

export function parseContextProvider(value: string): ContextIntegrationProvider {
  return contextIntegrationProviderSchema.parse(value);
}

export function createContextIntegrationDriver(provider: ContextIntegrationProvider): ContextIntegrationProviderDriver {
  return provider === "claude-code" ? new ClaudeCodeContextIntegrationDriver() : new CodexContextIntegrationDriver();
}
