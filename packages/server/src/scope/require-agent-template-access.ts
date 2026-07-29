import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { members } from "../db/schema/members.js";
import { NotFoundError } from "../errors.js";
import { stampOrgScope } from "../observability/request-context.js";
import { requireUser } from "./require-user.js";
import type { OrgScope } from "./types.js";

type AgentTemplateRow = typeof agentTemplates.$inferSelect;

/**
 * Class C access for one official Agent Template.
 *
 * Consumers browse the public projection through their own org-scoped
 * catalog route. The full definition is intentionally visible only inside
 * the publisher Team because it exposes Resource ids and authoring metadata.
 */
export async function requireAgentTemplateAccess(
  request: FastifyRequest<{ Params: { templateId: string } }>,
  db: Database,
  kind: "read" | "write",
): Promise<{ template: AgentTemplateRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const [template] = await db
    .select()
    .from(agentTemplates)
    .where(eq(agentTemplates.id, request.params.templateId))
    .limit(1);
  if (!template) throw new NotFoundError("Agent Template not found");

  const [member] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, template.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!member || (member.role !== "admin" && member.role !== "member")) {
    throw new NotFoundError("Agent Template not found");
  }
  if (kind === "write" && member.role !== "admin") {
    throw new NotFoundError("Agent Template not found");
  }

  const scope: OrgScope = {
    userId,
    organizationId: template.organizationId,
    memberId: member.id,
    role: member.role,
    humanAgentId: member.agentId,
  };
  stampOrgScope(request, scope);
  return { template, scope };
}
