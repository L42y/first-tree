import {
  type ContextEnablementHandoff,
  type ContextEnablementIntent,
  type ContextIntegrationProvider,
  contextEnablementHandoffSchema,
} from "@first-tree/shared";
import { api, withOrgAt } from "./client.js";

export function getContextEnablementHandoff(
  organizationId: string,
  provider: ContextIntegrationProvider,
  intent: ContextEnablementIntent = "settings",
): Promise<ContextEnablementHandoff> {
  const query = new URLSearchParams({ provider, intent });
  return api
    .get<unknown>(`${withOrgAt(organizationId, "/context-enablement/handoff")}?${query.toString()}`)
    .then((response) => contextEnablementHandoffSchema.parse(response));
}
