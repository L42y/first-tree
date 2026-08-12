import { isKnownLandingCampaignSlug, parseAgentTemplateIntentPath } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { users } from "../../../db/schema/users.js";
import { findActiveByToken, recordRedemption } from "../../team/invitation.js";
import {
  createPersonalTeam,
  ensureMembership,
  personalTeamDisplayName,
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
  agentFirstOnboardingEnabled: boolean;
};

export type ExternalAccountBootstrapResult = {
  account: ExternalAccountBootstrapUser;
  joinPath: "invite" | "solo" | "returning";
  next: string;
  /**
   * `null` for a gated Agent-first solo path. Deployments that have not shipped
   * the complete Runtime-to-channel continuation keep the established
   * personal-Team bootstrap and return its organization id.
   */
  organizationId: string | null;
  orgPinned: boolean;
  /** Internal funnel fact; never serialized as a Web onboarding state. */
  teamCreated: boolean;
};

export const OAUTH_BOOTSTRAP_ERROR_CODES = ["invite-invalid", "invite-not-allowed", "invite-required"] as const;
export type OAuthBootstrapErrorCode = (typeof OAUTH_BOOTSTRAP_ERROR_CODES)[number];

export class OAuthBootstrapError extends Error {
  readonly code: OAuthBootstrapErrorCode;

  constructor(code: OAuthBootstrapErrorCode) {
    super(code);
    this.name = "OAuthBootstrapError";
    this.code = code;
  }
}

export async function completeExternalAccountBootstrap(
  db: Database,
  account: ExternalAccountBootstrapUser,
  input: ExternalAccountBootstrapInput,
): Promise<ExternalAccountBootstrapResult> {
  return db.transaction(async (tx) => {
    // Drizzle's transaction callback exposes the same runtime query surface as
    // `Database`, but its inferred type omits the app's relational-query
    // decoration. Bootstrap uses only the shared query-builder methods.
    const txDb = tx as unknown as Database;
    const [lockedUser] = await txDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, account.userId))
      .for("no key update")
      .limit(1);
    if (!lockedUser) throw new Error("External account bootstrap references a missing user");

    // Serializing on the stable user row keeps invite redemption, returning
    // membership resolution, and concurrent first-Team provisioning from
    // observing incompatible account states.
    const inviteMatch = /^\/invite\/([^/?#]+)/.exec(input.next);
    if (inviteMatch?.[1]) {
      const invitation = await findActiveByToken(txDb, inviteMatch[1]);
      if (!invitation) throw new OAuthBootstrapError("invite-invalid");
      if (input.allowedOrganizationId && invitation.organizationId !== input.allowedOrganizationId) {
        throw new OAuthBootstrapError("invite-not-allowed");
      }
      await ensureMembership(txDb, {
        userId: account.userId,
        organizationId: invitation.organizationId,
        role: invitation.role === "admin" ? "admin" : "member",
        displayName: account.displayName,
        username: account.username,
      });
      await recordRedemption(txDb, {
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

    const primary = await pickPrimaryMembership(txDb, account.userId);
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

    if (!input.agentFirstOnboardingEnabled) {
      const team = await createPersonalTeam(txDb, {
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
    }

    // The gated Agent-first flow deliberately leaves solo sign-in Team-less;
    // the Team and first Agent are created together only after confirmation.
    return {
      account,
      joinPath: "solo",
      next: shouldPreserveSoloSignupNext(input.next) ? input.next : "/",
      organizationId: null,
      orgPinned: false,
      teamCreated: false,
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
