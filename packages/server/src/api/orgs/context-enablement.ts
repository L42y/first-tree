import {
  contextEnablementHandoffQuerySchema,
  contextEnablementHandoffSchema,
  portableCliExecutable,
} from "@first-tree/shared";
import { type ChannelConfig, getServerCliBinding } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import { getOrganization } from "../../services/organization.js";

export async function orgContextEnablementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { orgId: string };
    Querystring: { provider?: string; intent?: string };
  }>("/handoff", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = contextEnablementHandoffQuerySchema.parse(request.query);
    const organization = await getOrganization(app.db, scope.organizationId);
    const executable = contextEnablementExecutable(getServerCliBinding());
    return contextEnablementHandoffSchema.parse({
      protocolVersion: 1,
      organizationId: scope.organizationId,
      teamDisplayName: organization.displayName,
      role: scope.role,
      provider: query.provider,
      intent: query.intent,
      command: [
        `${executable} --json context enable`,
        `--provider ${shellQuote(query.provider)}`,
        `--team ${shellQuote(scope.organizationId)}`,
        "--plan",
      ].join(" "),
      workingDirectoryInstruction:
        query.provider === "claude-code"
          ? "Run unchanged inside Claude Code. The CLI reads and displays the host-provided Claude project directory before asking for activation scope."
          : "Run unchanged inside Codex. The CLI displays the real canonical cwd and warns when it is a Codex session temporary directory.",
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function contextEnablementExecutable(binding: Pick<ChannelConfig, "binName" | "channel">): string {
  // The non-dev bootstrap installs and logs in through this exact portable
  // path. Keep enable on the same binary so an older global npm install that
  // appears earlier on PATH cannot satisfy a newer Web handoff contract.
  return binding.channel === "dev" ? shellQuote(binding.binName) : portableCliExecutable(binding.binName);
}
