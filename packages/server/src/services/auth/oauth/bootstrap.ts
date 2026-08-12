import { isKnownLandingCampaignSlug, parseAgentTemplateIntentPath } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { users } from "../../../db/schema/users.js";
import { findActiveByToken, recordRedemption } from "../../team/invitation.js";
import { ensureMembership, pickPrimaryMembership } from "../../team/membership.js";

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
  /**
   * `null` for the solo path: signing in no longer provisions a Team. The
   * account is legitimately Team-less until the user confirms their first Team
   * Agent, which creates the Team as part of that one atomic call.
   */
  organizationId: string | null;
  orgPinned: boolean;
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
      };
    }

    if (input.allowedOrganizationId) throw new OAuthBootstrapError("invite-required");

    // Solo: authenticated with no Team at all. Nothing is provisioned here —
    // an empty Team created before the user confirms anything is a resource
    // nobody asked for, and it makes "which Team is this Agent for" a question
    // the product has to answer twice. `POST /me/team-agents` creates the Team
    // together with the first Agent when the user confirms it.
    return {
      account,
      joinPath: "solo",
      next: shouldPreserveSoloSignupNext(input.next) ? input.next : "/",
      organizationId: null,
      orgPinned: false,
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
