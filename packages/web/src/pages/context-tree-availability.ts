import type { ContextTreeContentAvailability, ContextTreeSnapshot } from "@first-tree/shared";

export type ContextTreeSnapshotAvailability = Pick<
  ContextTreeSnapshot,
  "snapshotStatus" | "provider" | "contentAvailability"
>;

type ContextTreeUnavailableReason = Extract<ContextTreeContentAvailability, { status: "unavailable" }>["reason"];

const TEAM_NON_ACTIONABLE_GITLAB_REASONS = new Set<ContextTreeUnavailableReason>([
  "gitlab_authentication_required",
  "gitlab_origin_not_authorized",
  "gitlab_dns_unavailable",
  "gitlab_address_not_authorized",
  "gitlab_egress_denied",
]);

export const GITLAB_WEB_CONTEXT_UNAVAILABLE_TITLE = "Web preview isn’t available for this repository";

export const GITLAB_WEB_CONTEXT_UNAVAILABLE_DETAIL = "Agent access and Automatic Review are unaffected.";

export function isTeamNonActionableGitlabWebContext(
  snapshot: ContextTreeSnapshotAvailability | null | undefined,
): boolean {
  return (
    snapshot?.provider === "gitlab" &&
    snapshot.contentAvailability?.status === "unavailable" &&
    TEAM_NON_ACTIONABLE_GITLAB_REASONS.has(snapshot.contentAvailability.reason)
  );
}
