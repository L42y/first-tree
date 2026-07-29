import type { SetupBlocker, TeamSetupCapabilities } from "@first-tree/shared";
import {
  type ContextTreeSnapshotAvailability,
  isTeamNonActionableGitlabWebContext,
} from "../context-tree-availability.js";

function hasAdminOwnedBlocker(blockers: SetupBlocker[]): boolean {
  return blockers.some((blocker) => blocker.resolutionOwner === "admin");
}

/**
 * Decide whether Team Setup needs an action from the current admin.
 *
 * The Server projection is the sole source of Team readiness here. Optional
 * capabilities stay neutral until adopted: an available provider, an unbound
 * Context Tree, and unavailable/disabled Automatic Review must not light up
 * the Settings navigation merely because they are not configured.
 */
export function teamSetupNeedsAttention(
  capabilities: TeamSetupCapabilities | null | undefined,
  role: string | null,
): boolean {
  if (role !== "admin" || !capabilities) return false;

  const repositoryAutomationNeedsAttention = capabilities.repositoryAutomation.providers.some(
    (provider) => provider.adoption !== "available" && hasAdminOwnedBlocker(provider.blockers),
  );
  const contextTreeNeedsAttention =
    capabilities.contextTree.binding.state !== "unbound" && hasAdminOwnedBlocker(capabilities.contextTree.blockers);
  const automaticReviewNeedsAttention =
    capabilities.contextTree.automaticReview.adoption === "enabled" &&
    hasAdminOwnedBlocker(capabilities.contextTree.automaticReview.blockers);

  return repositoryAutomationNeedsAttention || contextTreeNeedsAttention || automaticReviewNeedsAttention;
}

export function contextTreeSnapshotNeedsAttention(
  snapshot: ContextTreeSnapshotAvailability | null | undefined,
  role: string | null,
): boolean {
  return (
    role === "admin" && snapshot?.snapshotStatus === "unavailable" && !isTeamNonActionableGitlabWebContext(snapshot)
  );
}

export function personalSetupNeedsAttention({
  currentOrgHasUsableAgent,
  onboardingDismissedAt,
  onboardingCompletedAt,
  role,
}: {
  currentOrgHasUsableAgent: boolean;
  onboardingDismissedAt: string | null;
  onboardingCompletedAt: string | null;
  role: string | null;
}): boolean {
  // A member may intentionally complete onboarding with a Team agent or an
  // external coding agent. An admin's Setup attention still represents Team
  // readiness, so member completion must not suppress missing admin setup.
  if (role === "member" && onboardingCompletedAt !== null) return false;
  return currentOrgHasUsableAgent === false || onboardingDismissedAt !== null;
}
