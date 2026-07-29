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

export const GITLAB_WEB_CONTEXT_UNAVAILABLE_TITLE = "GitLab Web Context isn’t available for this repository";

export const GITLAB_WEB_CONTEXT_UNAVAILABLE_DETAIL =
  "First Tree can’t display this Context Tree in the web app. Agents and Context Reviewer with repository access can continue using it as usual.";

export function isTeamNonActionableGitlabWebContext(
  snapshot: ContextTreeSnapshotAvailability | null | undefined,
): boolean {
  return (
    snapshot?.provider === "gitlab" &&
    snapshot.contentAvailability?.status === "unavailable" &&
    TEAM_NON_ACTIONABLE_GITLAB_REASONS.has(snapshot.contentAvailability.reason)
  );
}
