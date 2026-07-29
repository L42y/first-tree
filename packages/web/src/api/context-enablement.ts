import type { ContextEnablementHandoff, ContextIntegrationProvider } from "@first-tree/shared";
import { api, withOrgAt } from "./client.js";

export function getContextEnablementHandoff(
  organizationId: string,
  provider: ContextIntegrationProvider,
): Promise<ContextEnablementHandoff> {
  return api.get<ContextEnablementHandoff>(
    `${withOrgAt(organizationId, "/context-enablement/handoff")}?provider=${encodeURIComponent(provider)}`,
  );
}
