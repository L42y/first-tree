import { AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES } from "@first-tree/shared";
import { listManagedAgents, type ManagedAgent } from "../../api/agents.js";
import { ApiError } from "../../api/client.js";

/**
 * Recovering the Agent that a lost create response already made.
 *
 * OpenTag sends the derived Agent handle, which is unique per Team, so a
 * member who presses Confirm again after a lost response gets a name conflict
 * rather than a second Agent. That conflict is the signal that the first
 * request may well have committed — but the name alone proves nothing, so the
 * lookup is deliberately narrow and its result is never adopted silently:
 *
 *   - it reads `/me/managed-agents`, which is scoped to Agents this member
 *     actually manages, so a teammate's same-named Agent can never surface;
 *   - it requires the exact Team and the exact handle OpenTag derived;
 *   - the caller offers the match to the member as an explicit choice.
 *
 * Returns null for any other failure and for a conflict this member cannot
 * resolve — then the server's own message is the honest thing to show.
 */
export function isAgentNameConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.NAME_CONFLICT
  );
}

export function findManagedAgentByHandle(
  agents: readonly ManagedAgent[],
  handle: string,
  organizationId: string | null,
): ManagedAgent | null {
  return (
    agents.find(
      (agent) =>
        agent.name === handle &&
        agent.type === "agent" &&
        agent.status !== "deleted" &&
        (!organizationId || agent.organizationId === organizationId),
    ) ?? null
  );
}

export async function recoverCreatedAgent(handle: string, organizationId: string | null): Promise<ManagedAgent | null> {
  try {
    return findManagedAgentByHandle(await listManagedAgents(), handle, organizationId);
  } catch {
    // Best-effort: without the lookup the member still sees the conflict and
    // can rename, which is worse but never wrong.
    return null;
  }
}
