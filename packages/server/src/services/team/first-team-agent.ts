import { createHmac } from "node:crypto";
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  type AgentVisibility,
  FIRST_TEAM_AGENT_CONTINUATION_METADATA_KEY,
  PROVISION_FIRST_TEAM_AGENT_ERROR_CODES,
  type ProvisionFirstTeamAgent,
  type ProvisionFirstTeamAgentResult,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { ConflictError, ForbiddenError } from "../../errors.js";
import { createAgent } from "../agents/identity.js";
import type { AttachmentBlobStore } from "../attachment-blob-store.js";
import {
  createPersonalTeam,
  lockMembershipLifecycleUser,
  MEMBER_STATUSES,
  personalTeamDisplayName,
} from "./membership.js";

export type ProvisionFirstTeamAgentInput = ProvisionFirstTeamAgent & { userId: string };

export type ProvisionFirstTeamAgentOptions = {
  attachmentBlobStore: AttachmentBlobStore;
  idempotencySecret: string;
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
    // Drizzle's transaction callback exposes the same runtime query surface as
    // `Database`, but its inferred type omits the app's relational-query
    // decoration. This service uses only the shared query-builder methods.
    const txDb = tx as unknown as Database;

    const lockedUser = await lockMembershipLifecycleUser(txDb, input.userId);

    const memberships = await txDb
      .select({
        memberId: members.id,
        organizationId: members.organizationId,
      })
      .from(members)
      .where(and(eq(members.userId, input.userId), eq(members.status, MEMBER_STATUSES.ACTIVE)));

    if (memberships.length > 0) {
      // A request that lost the user-row race may now observe the Team and
      // Agent created by the winner. Only an exact logical retry converges;
      // a different name or Template intent must never be reported as if it
      // had been adopted. All other existing-Team creation belongs to the
      // org-scoped Agent endpoint.
      const existing = await findExactRetry(txDb, memberships, input, options.idempotencySecret);
      if (!existing) {
        throw new ConflictError(
          "A Team membership already exists or a different first Team Agent was provisioned. Create additional Agents through the Team-scoped endpoint.",
          { code: PROVISION_FIRST_TEAM_AGENT_ERROR_CODES.REQUEST_CONFLICT },
        );
      }
      return {
        organizationId: existing.organizationId,
        memberId: existing.memberId,
        teamCreated: false,
        agentCreated: false,
        agent: existing.agent,
      };
    }

    if (options.allowedOrganizationId) {
      throw new ForbiddenError("This server requires an invitation link to join a team.");
    }

    const target = await createInitialTeam(txDb, input.userId, lockedUser);
    const agentUuid = deriveFirstTeamAgentUuid(options.idempotencySecret, input);
    const agentName = await resolveFirstTeamAgentName(txDb, target.organizationId, input.name, agentUuid);

    const agent = await createAgent(
      txDb,
      {
        type: AGENT_TYPES.AGENT,
        name: agentName,
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
        uuid: agentUuid,
      },
    );

    // Stable creator provenance and continuation live on the membership's
    // 1:1 human mirror, not on mutable role or Agent-manager relationships.
    // The marker is written inside the same transaction as the Team graph.
    await txDb
      .update(agents)
      .set({
        metadata: sql`jsonb_set(
          ${agents.metadata},
          ARRAY[${FIRST_TEAM_AGENT_CONTINUATION_METADATA_KEY}]::text[],
          ${JSON.stringify({ agentId: agent.uuid })}::jsonb,
          true
        )`,
      })
      .where(eq(agents.uuid, target.humanAgentId));

    // Keep the existing Team-agent suppressor as an auto-open control only.
    // The internal human-mirror marker above is the unambiguous creator and
    // exact Runtime continuation identity.
    await txDb
      .update(members)
      .set({
        onboardingSuppressedAt: new Date(),
        onboardingSuppressedReason: "invitee_skip",
      })
      .where(eq(members.id, target.memberId));

    return {
      organizationId: target.organizationId,
      memberId: target.memberId,
      teamCreated: true,
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
};

/**
 * Create the Team for the genuine no-membership starting state. Membership
 * resolution is deliberately absent: once a Team exists, Agent creation is a
 * Class B operation on `POST /orgs/:orgId/agents`.
 */
async function createInitialTeam(
  db: Database,
  userId: string,
  user: { username: string; displayName: string },
): Promise<TargetTeam> {
  const team = await createPersonalTeam(db, {
    userId,
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
  };
}

type ExistingMembership = {
  memberId: string;
  organizationId: string;
};

/** Resolve only an exact retry of the first-Team request. */
async function findExactRetry(
  db: Database,
  memberships: ExistingMembership[],
  input: ProvisionFirstTeamAgentInput,
  idempotencySecret: string,
): Promise<{
  organizationId: string;
  memberId: string;
  agent: ProvisionFirstTeamAgentOutcome["agent"];
} | null> {
  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      visibility: agents.visibility,
      clientId: agents.clientId,
      organizationId: agents.organizationId,
      memberId: agents.managerId,
    })
    .from(agents)
    .where(
      and(
        inArray(
          agents.managerId,
          memberships.map((membership) => membership.memberId),
        ),
        eq(agents.uuid, deriveFirstTeamAgentUuid(idempotencySecret, input)),
        eq(agents.type, AGENT_TYPES.AGENT),
        ne(agents.status, AGENT_STATUSES.DELETED),
      ),
    );

  const candidate = rows[0];
  if (!candidate) return null;
  return {
    organizationId: candidate.organizationId,
    memberId: candidate.memberId,
    agent: {
      uuid: candidate.uuid,
      name: candidate.name,
      displayName: candidate.displayName,
      visibility: toAgentVisibility(candidate.visibility),
      clientId: candidate.clientId,
    },
  };
}

/**
 * The first Team transaction creates the human mirror before the non-human
 * Agent. Keep naming inside that transaction so the Web caller does not need
 * to predict an org-local collision it cannot observe. The request-derived
 * Agent UUID makes the fallback stable across exact retries.
 */
async function resolveFirstTeamAgentName(
  db: Database,
  organizationId: string,
  requestedName: string | undefined,
  agentUuid: string,
): Promise<string> {
  const baseName = requestedName ?? "team-agent";
  const [collision] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.name, baseName), ne(agents.uuid, agentUuid)))
    .limit(1);
  if (!collision) return baseName;

  const suffix = agentUuid.slice(0, 8);
  const baseLength = AGENT_NAME_MAX_LENGTH - suffix.length - 1;
  return `${baseName.slice(0, baseLength)}-${suffix}`;
}

/**
 * Bind the canonical creation intent to this user and public request id without
 * storing a second idempotency record. The request's UUID-v7 timestamp stays in
 * the resulting Agent UUID; HMAC-derived random bits prevent either a changed
 * payload or a later existing-Team caller from masquerading as the completed
 * request.
 */
function deriveFirstTeamAgentUuid(secret: string, input: ProvisionFirstTeamAgentInput): string {
  const requestBytes = Buffer.from(input.requestId.replaceAll("-", ""), "hex");
  const canonicalIntent = JSON.stringify([
    input.name ?? null,
    input.displayName?.trim() ?? null,
    input.templateIds ?? [],
  ]);
  const bytes = Buffer.from(
    createHmac("sha256", secret)
      .update(input.userId)
      .update("\0")
      .update(input.requestId)
      .update("\0")
      .update(canonicalIntent)
      .digest()
      .subarray(0, 16),
  );
  requestBytes.copy(bytes, 0, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
