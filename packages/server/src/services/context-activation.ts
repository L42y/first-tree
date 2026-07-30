import {
  type ContextActivationRequest,
  type ContextActivationResponse,
  resolveContextTreeProvider,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { resources } from "../db/schema/resources.js";
import type { OrgScope } from "../scope/types.js";
import { getOrgContextTreeSettingState } from "./org-settings.js";
import { getOrganization } from "./organization.js";

const REPOSITORIES_SETTINGS_URL = "/settings/repositories#code-repositories";
const CONTEXT_TREE_SETTINGS_URL = "/settings/context#binding";

export async function validateExternalContextActivation(
  db: Database,
  scope: Pick<OrgScope, "organizationId" | "role">,
  input: ContextActivationRequest,
): Promise<ContextActivationResponse> {
  const organization = await getOrganization(db, scope.organizationId);

  const team = {
    organizationId: scope.organizationId,
    displayName: organization.displayName,
    role: scope.role,
  } as const;

  const [repository] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, scope.organizationId),
        eq(resources.scope, "team"),
        eq(resources.type, "repo"),
        eq(resources.status, "active"),
        eq(resources.repoCanonicalKey, input.repositoryKey),
      ),
    )
    .limit(1);

  if (!repository) {
    return {
      schemaVersion: 1,
      outcome: "disabled",
      team: {
        organizationId: team.organizationId,
        displayName: team.displayName,
      },
      reasonCode: "repository_not_in_selected_team_scope",
      nextAction: {
        message: `This repository is not in ${team.displayName}'s Context scope. Ask a Team Admin to add it in Settings → Repositories.`,
        settingsUrl: REPOSITORIES_SETTINGS_URL,
      },
    };
  }

  const tree = await getOrgContextTreeSettingState(db, scope.organizationId);
  if (tree.kind === "unbound") {
    return needsAdmin(team, "context_tree_unbound", "This Team has not connected a Context Tree yet.");
  }
  if (tree.kind === "invalid") {
    return needsAdmin(team, "context_tree_binding_invalid", "This Team's Context Tree binding needs repair.");
  }
  const [gitlabConnection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, scope.organizationId))
    .limit(1);
  const resolution = resolveContextTreeProvider({
    repo: tree.binding.repo,
    declaredProvider: tree.binding.provider,
    gitlabInstanceOrigin: gitlabConnection?.instanceOrigin,
  });
  const gitlabIdentity =
    resolution.provider === "gitlab"
      ? resolveGitLabRepositoryWebIdentity(tree.binding.repo, gitlabConnection?.instanceOrigin)
      : null;
  const providerMatchesRepository =
    resolution.provider !== null &&
    resolution.declaredProviderMatches &&
    (resolution.provider !== "gitlab" || gitlabIdentity?.originMatchesConnection === true);
  if (!providerMatchesRepository) {
    return needsAdmin(
      team,
      "context_tree_provider_unresolved",
      "First Tree cannot resolve the provider for this Team's Context Tree binding.",
    );
  }

  return {
    schemaVersion: 1,
    outcome: "connected",
    team,
  };
}

function needsAdmin(
  team: {
    organizationId: string;
    displayName: string;
    role: "admin" | "member";
  },
  reasonCode: "context_tree_unbound" | "context_tree_binding_invalid" | "context_tree_provider_unresolved",
  message: string,
): ContextActivationResponse {
  return {
    schemaVersion: 1,
    outcome: "needs_admin",
    team,
    reasonCode,
    nextAction: {
      message,
      settingsUrl: CONTEXT_TREE_SETTINGS_URL,
    },
  };
}
