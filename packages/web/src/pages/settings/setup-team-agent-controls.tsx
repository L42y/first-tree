import type { OrgGithubFeaturesOutput, SetupBlocker, TeamAgentCandidatesOutput } from "@first-tree/shared";
import { setupBlockerCodeSchema } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { getGithubFeaturesSetting } from "../../api/org-settings.js";
import { setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { getTeamAgentCandidates, putTeamAgentAssignment } from "../../api/team-agent-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Select } from "../../components/ui/select.js";
import { setupBlockerCopy } from "./setup-blocker-copy.js";

export function SetupTeamAgentControls({
  loadSetting = getGithubFeaturesSetting,
  loadCandidates = getTeamAgentCandidates,
  assignTeamAgent = putTeamAgentAssignment,
}: {
  loadSetting?: (organizationId: string) => Promise<OrgGithubFeaturesOutput>;
  loadCandidates?: (organizationId: string) => Promise<TeamAgentCandidatesOutput>;
  assignTeamAgent?: (organizationId: string, agentUuid: string | null) => Promise<OrgGithubFeaturesOutput>;
}) {
  const { organizationId, role } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = role === "admin";
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string | null>(null);

  const settingQuery = useQuery({
    queryKey: ["team-agent", "setting", organizationId],
    queryFn: () =>
      organizationId ? loadSetting(organizationId) : Promise.reject(new Error("organization not loaded")),
    enabled: isAdmin && !!organizationId,
  });
  const candidatesQuery = useQuery({
    queryKey: ["team-agent", "candidates", organizationId],
    queryFn: () =>
      organizationId ? loadCandidates(organizationId) : Promise.reject(new Error("organization not loaded")),
    enabled: isAdmin && !!organizationId,
  });

  const projectedAgentUuid = settingQuery.data?.teamAgent.agentUuid ?? null;
  useEffect(() => {
    setSelectedAgentUuid(projectedAgentUuid);
  }, [projectedAgentUuid]);

  const assignmentMutation = useMutation({
    mutationFn: (agentUuid: string | null) => {
      if (!organizationId) throw new Error("organization not loaded");
      return assignTeamAgent(organizationId, agentUuid);
    },
    onSuccess: async (next) => {
      setSelectedAgentUuid(next.teamAgent.agentUuid);
      queryClient.setQueryData(["team-agent", "setting", organizationId], next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["team-agent", "candidates", organizationId] }),
        queryClient.invalidateQueries({ queryKey: ["context-reviewer", "candidates", organizationId] }),
        queryClient.invalidateQueries({ queryKey: setupCapabilitiesQueryKey(organizationId) }),
      ]);
    },
  });

  if (!isAdmin) return null;

  const candidates = candidatesQuery.data?.items ?? [];
  const selectedCandidate = candidates.find((candidate) => candidate.uuid === selectedAgentUuid) ?? null;
  const selectedLabel =
    selectedCandidate?.displayName ??
    (selectedAgentUuid === projectedAgentUuid ? settingQuery.data?.teamAgent.agent?.displayName : null) ??
    null;
  const options = [
    {
      value: "",
      label: selectedAgentUuid ? "No Team Agent selected" : "Select an eligible Team Agent",
      disabled: !selectedAgentUuid,
    },
    ...candidates.map((candidate) => ({
      value: candidate.uuid,
      label: candidate.displayName,
      hint:
        candidate.runtime.health === "ready"
          ? candidate.name || "Runtime ready"
          : `${candidate.name ? `${candidate.name} · ` : ""}${runtimeLabel(candidate.runtime.health)}`,
    })),
  ];
  const blockers = candidatesQuery.data?.blockers ?? [];
  const error = settingQuery.error ?? candidatesQuery.error ?? assignmentMutation.error;

  return (
    <div
      data-setup-owner-controls="team-agent"
      className="flex flex-col"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-4)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "var(--bg-sunken)",
      }}
    >
      <div>
        <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Team Agent
        </span>
        <div className="text-label" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
          {selectedLabel
            ? `${selectedLabel} handles GitHub App mentions and assignments outside the Context Tree repository.`
            : "Choose the Agent that handles GitHub App mentions and assignments outside the Context Tree repository."}
        </div>
      </div>

      {settingQuery.isLoading || candidatesQuery.isLoading ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          Loading eligible Agents…
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          {blockerText(blockers)}{" "}
          <Link
            to={
              blockers.some((item) => item.code === "github_app_slug_missing")
                ? "/settings/integrations/github"
                : "/team"
            }
            className="font-medium"
            style={{ color: "var(--fg-2)" }}
          >
            {blockers.some((item) => item.code === "github_app_slug_missing") ? "Manage GitHub" : "Manage Team Agents"}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <Select
            aria-label="Team Agent"
            value={selectedAgentUuid ?? ""}
            onChange={(agentUuid) => {
              const next = agentUuid || null;
              if (next === selectedAgentUuid) return;
              assignmentMutation.mutate(next);
            }}
            disabled={assignmentMutation.isPending}
            options={options}
            placeholder="Select an eligible Team Agent"
            searchable={candidates.length > 6}
          />
          <div className="text-caption" style={{ color: "var(--fg-4)" }}>
            The Team Agent and Context Reviewer must be different Agents. Automatic Review does not control this
            delegation.
          </div>
        </div>
      )}

      {error ? (
        <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          {teamAgentMutationError(error)}
        </div>
      ) : null}
    </div>
  );
}

function blockerText(blockers: SetupBlocker[]): string {
  const details = [...new Set(blockers.map((item) => setupBlockerCopy(item.code)))];
  return details.length > 0 ? details.join(" · ") : "No eligible organization-visible managed Agent is available.";
}

function teamAgentMutationError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const code = setupBlockerCodeSchema.safeParse(error.code);
    if (code.success) return setupBlockerCopy(code.data);
  }
  return error instanceof Error ? error.message : "Failed to update Team Agent";
}

function runtimeLabel(health: "not_observed" | "pending_verification" | "ready" | "degraded" | "unavailable"): string {
  switch (health) {
    case "not_observed":
      return "Runtime not observed";
    case "pending_verification":
      return "Runtime verification pending";
    case "ready":
      return "Runtime ready";
    case "degraded":
      return "Runtime currently unavailable";
    case "unavailable":
      return "Runtime unavailable";
  }
}
