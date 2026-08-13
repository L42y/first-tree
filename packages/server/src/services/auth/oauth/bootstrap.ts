import { isKnownLandingCampaignSlug, parseAgentTemplateIntentPath } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { members } from "../../../db/schema/members.js";
import { users } from "../../../db/schema/users.js";
import { UnauthorizedError } from "../../../errors.js";
import { findActiveByToken, recordRedemption } from "../../team/invitation.js";
import {
  createPersonalTeamInTransaction,
  ensureMembershipInTransaction,
  MEMBER_STATUSES,
  pickPrimaryMembership,
} from "../../team/membership.js";

export type ExternalAccountBootstrapUser = {
  userId: string;
  username: string;
  displayName: string;
  created: boolean;
};

export type ExternalAccountBootstrapInput = {
  next: string;
  allowedOrganizationId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type ExternalAccountBootstrapResult = {
  account: ExternalAccountBootstrapUser;
  joinPath: "invite" | "solo" | "returning";
  next: string;
  organizationId: string;
  orgPinned: boolean;
  teamCreated: boolean;
};

export const OAUTH_BOOTSTRAP_ERROR_CODES = [
  "account-inactive",
  "invite-invalid",
  "invite-not-allowed",
  "invite-required",
  "membership-restore-required",
] as const;
export type OAuthBootstrapErrorCode = (typeof OAUTH_BOOTSTRAP_ERROR_CODES)[number];

export class OAuthBootstrapError extends Error {
  readonly code: OAuthBootstrapErrorCode;

  constructor(code: OAuthBootstrapErrorCode) {
    super(code);
    this.name = "OAuthBootstrapError";
    this.code = code;
  }
}

export function oauthBootstrapBoundary(error: unknown): OAuthBootstrapError | null {
  if (error instanceof OAuthBootstrapError) return error;
  if (!(error instanceof UnauthorizedError)) return null;
  const code = error.attrs?.code;
  if (code === "account-inactive" || code === "invite-required") return new OAuthBootstrapError(code);
  return null;
}

export async function completeExternalAccountBootstrap(
  db: Database,
  account: ExternalAccountBootstrapUser,
  input: ExternalAccountBootstrapInput,
): Promise<ExternalAccountBootstrapResult> {
  return db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, account.userId))
      .for("no key update")
      .limit(1);
    if (!lockedUser) throw new Error("External account bootstrap references a missing user");
    if (lockedUser.status !== "active") throw new OAuthBootstrapError("account-inactive");

    // Serializing on the stable user row keeps two first sign-ins from both
    // observing an empty membership set and creating separate personal teams.
    const inviteMatch = /^\/invite\/([^/?#]+)/.exec(input.next);
    if (inviteMatch?.[1]) {
      const invitation = await findActiveByToken(tx, inviteMatch[1]);
      if (!invitation) throw new OAuthBootstrapError("invite-invalid");
      if (input.allowedOrganizationId && invitation.organizationId !== input.allowedOrganizationId) {
        throw new OAuthBootstrapError("invite-not-allowed");
      }
      const [stableMembership] = await tx
        .select({ status: members.status })
        .from(members)
        .where(and(eq(members.userId, account.userId), eq(members.organizationId, invitation.organizationId)))
        .limit(1);
      if (stableMembership?.status === MEMBER_STATUSES.REMOVED) {
        throw new OAuthBootstrapError("membership-restore-required");
      }
      await ensureMembershipInTransaction(tx, {
        userId: account.userId,
        organizationId: invitation.organizationId,
        role: invitation.role === "admin" ? "admin" : "member",
        displayName: account.displayName,
        username: account.username,
      });
      await recordRedemption(tx, {
        invitationId: invitation.id,
        userId: account.userId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        account,
        joinPath: "invite",
        next: "/",
        organizationId: invitation.organizationId,
        orgPinned: true,
        teamCreated: false,
      };
    }

    const primary = await pickPrimaryMembership(tx, account.userId);
    if (primary) {
      return {
        account,
        joinPath: "returning",
        next: input.next,
        organizationId: primary.organizationId,
        orgPinned: false,
        teamCreated: false,
      };
    }

    if (input.allowedOrganizationId) throw new OAuthBootstrapError("invite-required");

    const team = await createPersonalTeamInTransaction(tx, {
      userId: account.userId,
      username: account.username,
      teamDisplayName: personalTeamDisplayName(account.displayName),
      userDisplayName: account.displayName,
    });
    return {
      account,
      joinPath: "solo",
      next: shouldPreserveSoloSignupNext(input.next) ? input.next : "/",
      organizationId: team.organizationId,
      orgPinned: true,
      teamCreated: true,
    };
  });
}

export function shouldPreserveSoloSignupNext(next: string): boolean {
  // A canonical Agent Template "use" intent survives solo signup so the new
  // member lands back on the Template they picked. Parsing is strict (exact
  // pathname, schema slug, sole `use=1` query, no fragment) so this never
  // widens into a general deep-link preservation.
  if (parseAgentTemplateIntentPath(next) !== null) return true;
  const parsed = new URL(next, "http://first-tree.local");
  return parsed.pathname === "/quickstart" && isKnownLandingCampaignSlug(parsed.searchParams.get("campaign"));
}

export function personalTeamDisplayName(displayName: string): string {
  return `${displayName.slice(0, 193)}'s team`;
}
