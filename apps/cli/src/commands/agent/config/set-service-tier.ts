import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetServiceTierCommand(config: Command): void {
  config
    .command("set-service-tier <agent> <tier>")
    .description(
      "Set the Codex provider-native service tier (default = Standard, fast = Fast, or another provider-advertised id)",
    )
    .action(async (agentName: string, serviceTier: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, { serviceTier });
      success({
        agentId: updated.agentId,
        version: updated.version,
        serviceTier: "serviceTier" in updated.payload ? updated.payload.serviceTier : undefined,
      });
    });
}
