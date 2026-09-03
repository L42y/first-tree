import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AgentRuntimeSummary, summarizeRuntimeConfig } from "./agent-runtime";
import { api, withOrg } from "./api";
import { useAuth } from "./auth-context";
import { listOrgAgents } from "./team-api";

/**
 * Runtime facts for a set of agents, as far as the caller is allowed to see
 * them. The org roster supplies the provider for everyone; the model and
 * effort come from `GET /agents/:uuid/config`, which the server gates on
 * *manage* access, so it is only requested for agents this member manages.
 * Everyone else resolves to provider-only rather than an empty row.
 */
export function useAgentRuntimeSummaries(
  agentIds: readonly string[],
  opts: { enabled: boolean },
): Map<string, AgentRuntimeSummary> {
  const { memberId } = useAuth();
  const rosterQuery = useQuery({
    queryKey: ["agents", "org-list", "runtime-roster"],
    queryFn: ({ signal }) => listOrgAgents({ addressableOnly: false }, signal),
    enabled: opts.enabled,
    staleTime: 15_000,
    // Working/idle is live state, so an open roster surface keeps it current.
    refetchInterval: opts.enabled ? 20_000 : false,
  });

  const roster = useMemo(() => {
    const byId = new Map<
      string,
      {
        provider: string | null;
        managed: boolean;
        isHuman: boolean;
        status: string | null;
        runtimeState: string | null;
        presenceStatus: string | null;
      }
    >();
    for (const agent of rosterQuery.data ?? []) {
      byId.set(agent.uuid, {
        provider: agent.runtimeProvider,
        managed: Boolean(memberId && agent.managerId === memberId),
        isHuman: agent.type === "human",
        status: agent.status,
        runtimeState: agent.runtimeState,
        presenceStatus: agent.presenceStatus,
      });
    }
    return byId;
  }, [rosterQuery.data, memberId]);

  // Only managed, non-human agents have a readable config; anything else would
  // be a guaranteed 403 per row.
  const configurable = useMemo(
    () => agentIds.filter((agentId) => roster.get(agentId)?.managed && !roster.get(agentId)?.isHuman),
    [agentIds, roster],
  );

  const configQueries = useQueries({
    queries: configurable.map((agentId) => ({
      queryKey: ["agent", agentId, "runtime-config"],
      queryFn: () => api.get<{ payload?: unknown }>(withOrg(`/agents/${encodeURIComponent(agentId)}/config`)),
      enabled: opts.enabled,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  return useMemo(() => {
    const summaries = new Map<string, AgentRuntimeSummary>();
    for (const [agentId, entry] of roster) {
      if (entry.isHuman) continue;
      summaries.set(agentId, {
        provider: entry.provider,
        model: null,
        effort: null,
        status: entry.status,
        runtimeState: entry.runtimeState,
        presenceStatus: entry.presenceStatus,
        managed: entry.managed,
      });
    }
    configurable.forEach((agentId, index) => {
      const payload = configQueries[index]?.data?.payload;
      if (!payload) return;
      const entry = roster.get(agentId);
      summaries.set(agentId, {
        ...summarizeRuntimeConfig(payload, entry?.provider ?? null),
        status: entry?.status ?? null,
        runtimeState: entry?.runtimeState ?? null,
        presenceStatus: entry?.presenceStatus ?? null,
        managed: entry?.managed ?? false,
      });
    });
    return summaries;
  }, [configQueries, configurable, roster]);
}
