import {
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  type AgentVisibility,
  type ProvisionFirstTeamAgent,
  type ProvisionFirstTeamAgentResult,
} from "@first-tree/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import { createAgent } from "../agents/identity.js";
import type { AttachmentBlobStore } from "../attachment-blob-store.js";
import { pickDefaultMembership } from "./default-membership.js";
import { createPersonalTeam, MEMBER_STATUSES, personalTeamDisplayName } from "./membership.js";

export type ProvisionFirstTeamAgentInput = ProvisionFirstTeamAgent & { userId: string };

export type ProvisionFirstTeamAgentOptions = {
  attachmentBlobStore: AttachmentBlobStore;
  templatePublisherOrgId?: string;
  /**
   * Set on invitation-only deployments. A user with no Team there must redeem
   * an invite; provisioning must never mint a Team that bypasses that gate.
   */
  allowedOrganizationId?: string | null;
};

/**
 * Wire shape of this service, pinned to the shared DTO so the route cannot
 * drift from the contract the web client compiles against.
 */
export type ProvisionFirstTeamAgentOutcome = ProvisionFirstTeamAgentResult;

/**
 * `agents.visibility` is a text column, so Drizzle infers `string`. Narrow it
 * back to the contract rather than asserting: an unexpected stored value
 * surfaces here instead of silently escaping as a malformed response.
 */
function toAgentVisibility(value: string): AgentVisibility {
  if (value === AGENT_VISIBILITY.PRIVATE || value === AGENT_VISIBILITY.ORGANIZATION) return value;
  throw new Error(`Agent has an unsupported visibility "${value}"`);
}

/**
 * Provision the caller's first Team Agent — the single confirm step that turns
 * an authenticated Team-less account into a working Team.
 *
 * Everything the starting state needs lands in ONE transaction: the Team, the
 * caller's Admin membership, their 1:1 human mirror, the organization-visible
 * Agent, and any adopted Agent Templates. All-or-nothing is the point — a
 * half-provisioned account (a Team with no Agent, an Agent whose Template
 * import failed) is a state the product has no screen for and no way to repair
 * from the client.
 *
 * The transaction opens by locking the caller's stable `users` row, the same
 * serialization point OAuth bootstrap uses. That is what makes a double-click,
 * a retried request, or two browser tabs converge: the loser blocks, then
 * observes the winner's Team and Agent and returns them with
 * `teamCreated` / `agentCreated` false rather than minting a second set.
 *
 * The Agent is deliberately created UNBOUND (`clientId` null). Choosing a
 * Runtime is a separate, later step; the Agent is allowed to sit in "needs
 * setup" until then, so provisioning never depends on a connected computer.
 */
export async function provisionFirstTeamAgent(
  db: Database,
  input: ProvisionFirstTeamAgentInput,
  options: ProvisionFirstTeamAgentOptions,
): Promise<ProvisionFirstTeamAgentOutcome> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;

    const [lockedUser] = await txDb
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("no key update")
      .limit(1);
    if (!lockedUser) throw new NotFoundError(`User "${input.userId}" not found`);

    const target = await resolveTargetTeam(txDb, input, options, lockedUser);

    // Idempotent resolve. This route provisions THE first Agent, so a caller
    // who already has one in the target Team gets it back instead of a second
    // one — that is what makes a retry after an ambiguous network failure safe.
    const existing = await findFirstOwnAgent(txDb, target.memberId);
    if (existing) {
      return {
        organizationId: target.organizationId,
        memberId: target.memberId,
        teamCreated: target.teamCreated,
        agentCreated: false,
        agent: existing,
      };
    }

    const agent = await createAgent(
      txDb,
      {
        type: AGENT_TYPES.AGENT,
        name: input.name,
        displayName: input.displayName,
        // The object being created IS the Team's Agent; onboarding never asks
        // a second time who may use it.
        visibility: AGENT_VISIBILITY.ORGANIZATION,
        source: "portal",
        organizationId: target.organizationId,
        managerId: target.memberId,
        templateIds: input.templateIds,
      },
      {
        adoptAsDelegateIfFirst: true,
        attachmentBlobStore: options.attachmentBlobStore,
        templatePublisherOrgId: options.templatePublisherOrgId,
        templateActorMemberId: target.memberId,
        templateActorHumanAgentId: target.humanAgentId,
      },
    );

    return {
      organizationId: target.organizationId,
      memberId: target.memberId,
      teamCreated: target.teamCreated,
      agentCreated: true,
      agent: {
        uuid: agent.uuid,
        name: agent.name,
        displayName: agent.displayName,
        visibility: toAgentVisibility(agent.visibility),
        clientId: agent.clientId,
      },
    };
  });
}

type TargetTeam = {
  organizationId: string;
  memberId: string;
  humanAgentId: string;
  teamCreated: boolean;
};

/**
 * Decide which Team this Agent belongs to, creating one only for the genuine
 * no-org starting state.
 *
 * An explicit `organizationId` must resolve to an active membership of the
 * caller — it selects among Teams they already belong to and can never create
 * one. Without it the caller's current Team semantics apply: the default active
 * membership when they have any (so invited members act inside the Team that
 * invited them, and returning users stay in their own), otherwise a new Team.
 */
async function resolveTargetTeam(
  db: Database,
  input: ProvisionFirstTeamAgentInput,
  options: ProvisionFirstTeamAgentOptions,
  user: { username: string; displayName: string },
): Promise<TargetTeam> {
  const memberships = await db
    .select({
      memberId: members.id,
      organizationId: members.organizationId,
      agentId: members.agentId,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(and(eq(members.userId, input.userId), eq(members.status, MEMBER_STATUSES.ACTIVE)));

  if (input.organizationId) {
    const picked = memberships.find((m) => m.organizationId === input.organizationId);
    // Same response whether the Team does not exist or the caller is not in
    // it — membership is not something a non-member gets to probe.
    if (!picked) throw new NotFoundError(`Team "${input.organizationId}" not found`);
    return {
      organizationId: picked.organizationId,
      memberId: picked.memberId,
      humanAgentId: picked.agentId,
      teamCreated: false,
    };
  }

  // Reuse `/me`'s own selector rather than re-deriving "current Team" here:
  // the two must never disagree about which Team a user is acting in.
  const current = pickDefaultMembership(memberships.map((m) => ({ ...m, id: m.memberId })));
  if (current) {
    return {
      organizationId: current.organizationId,
      memberId: current.memberId,
      humanAgentId: current.agentId,
      teamCreated: false,
    };
  }

  if (options.allowedOrganizationId) {
    throw new ForbiddenError("This server requires an invitation link to join a team.");
  }

  const team = await createPersonalTeam(db, {
    userId: input.userId,
    username: user.username,
    teamDisplayName: personalTeamDisplayName(user.displayName),
    userDisplayName: user.displayName,
  });
  const [mirror] = await db
    .select({ agentId: members.agentId })
    .from(members)
    .where(eq(members.id, team.memberId))
    .limit(1);
  if (!mirror) throw new Error("Unexpected: the created Admin membership has no human mirror");
  return {
    organizationId: team.organizationId,
    memberId: team.memberId,
    humanAgentId: mirror.agentId,
    teamCreated: true,
  };
}

/** The member's own oldest live non-human Agent, if provisioning already ran. */
async function findFirstOwnAgent(
  db: Database,
  memberId: string,
): Promise<ProvisionFirstTeamAgentOutcome["agent"] | null> {
  const [row] = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      visibility: agents.visibility,
      clientId: agents.clientId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.managerId, memberId),
        eq(agents.type, AGENT_TYPES.AGENT),
        ne(agents.status, AGENT_STATUSES.DELETED),
      ),
    )
    .orderBy(asc(agents.uuid))
    .limit(1);
  if (!row) return null;
  return { ...row, visibility: toAgentVisibility(row.visibility) };
}
