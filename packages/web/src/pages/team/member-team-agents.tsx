import type { Agent, FeishuBotBinding } from "@first-tree/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageCircle } from "lucide-react";
import type { ReactElement } from "react";
import { Link } from "react-router";
import { listAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { feishuBindingQueryOptions, isFeishuHandoffUsable } from "../../features/feishu/binding-view.js";

const AGENT_PAGE_SIZE = 100;

type ReadyFeishuBotBinding = FeishuBotBinding & { appId: string };

type TeamAgentBinding = {
  agent: Agent;
  binding: ReadyFeishuBotBinding;
};

async function listAllAddressableTeamAgents(): Promise<Agent[]> {
  const agents: Agent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await listAgents({ limit: AGENT_PAGE_SIZE, type: "agent", addressableOnly: true, cursor });
    agents.push(...page.items);
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) return agents;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/**
 * Keep the Team roster's server-authored order. This page is a directory, not
 * a recommendation surface, so readiness only removes unavailable rows; it
 * never promotes or re-ranks the remaining Agents.
 */
export function selectReadyTeamAgents(
  agents: readonly Agent[],
  bindings: ReadonlyMap<string, FeishuBotBinding | null>,
): TeamAgentBinding[] {
  const ready: TeamAgentBinding[] = [];
  for (const agent of agents) {
    if (
      agent.type !== "agent" ||
      agent.status !== "active" ||
      agent.visibility !== "organization" ||
      agent.runtimeState == null
    ) {
      continue;
    }
    const binding = bindings.get(agent.uuid);
    const appId = binding?.appId?.trim();
    if (!binding || !appId || !isFeishuHandoffUsable(binding)) continue;
    ready.push({ agent, binding: { ...binding, appId } });
  }
  return ready;
}

/** Official Feishu AppLink for opening one Bot's private chat. */
export function feishuBotChatUrl(appId: string): string {
  const url = new URL("https://applink.feishu.cn/client/bot/open");
  url.searchParams.set("appId", appId);
  return url.toString();
}

export function teamAgentResponsibility(teamName: string): string {
  return `Ready to help ${teamName} in Feishu.`;
}

export function MemberTeamAgentsPage(): ReactElement {
  const { organizationId, teamDisplayName } = useAuth();
  const teamName = teamDisplayName ?? "your team";
  const agentsQuery = useQuery({
    queryKey: ["agents", "member-team-agents", organizationId],
    queryFn: listAllAddressableTeamAgents,
    staleTime: 30_000,
  });

  const eligibleAgents = (agentsQuery.data ?? []).filter(
    (agent) =>
      agent.type === "agent" &&
      agent.status === "active" &&
      agent.visibility === "organization" &&
      agent.runtimeState != null,
  );
  const bindingQueries = useQueries({
    queries: eligibleAgents.map((agent) => ({
      ...feishuBindingQueryOptions(agent.uuid, { poll: false }),
      staleTime: 10_000,
    })),
  });
  const bindings = new Map<string, FeishuBotBinding | null>();
  eligibleAgents.forEach((agent, index) => {
    bindings.set(agent.uuid, bindingQueries[index]?.data?.binding ?? null);
  });
  const readyAgents = selectReadyTeamAgents(eligibleAgents, bindings);

  const bindingReadFailed = bindingQueries.some((query) => query.isError);
  const loading = agentsQuery.isPending || bindingQueries.some((query) => query.isPending);
  const retry = (): void => {
    void agentsQuery.refetch();
    for (const query of bindingQueries) void query.refetch();
  };

  return (
    <>
      <PageHeader title="Team agents" subtitle={`Message ${teamName}'s ready agents in Feishu.`} />
      <div className="member-team-agents-page">
        {loading ? (
          <p className="member-team-agents-status" role="status">
            Loading team agents…
          </p>
        ) : agentsQuery.isError || bindingReadFailed ? (
          <div className="member-team-agents-status" role="alert">
            <p>We couldn’t check which team agents are ready.</p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : readyAgents.length === 0 ? (
          <EmptyTeamAgents teamName={teamName} />
        ) : (
          <>
            <div className="member-team-agent-grid" data-team-agent-count={readyAgents.length}>
              {readyAgents.map(({ agent, binding }) => (
                <TeamAgentCard
                  key={agent.uuid}
                  agent={agent}
                  binding={binding}
                  responsibility={teamAgentResponsibility(teamName)}
                />
              ))}
            </div>
            <GroupUseHint />
          </>
        )}
        <CreateTeamAgentEntry />
      </div>
    </>
  );
}

function CreateTeamAgentEntry(): ReactElement {
  return (
    <Button
      asChild
      variant="link"
      size="sm"
      className="h-auto self-start p-0 text-label"
      style={{ color: "var(--fg-3)" }}
    >
      <Link to="/opentag">Create a Team Agent</Link>
    </Button>
  );
}

function TeamAgentCard({
  agent,
  binding,
  responsibility,
}: {
  agent: Agent;
  binding: ReadyFeishuBotBinding;
  responsibility: string;
}): ReactElement {
  return (
    <Card className="member-team-agent-card">
      <CardHeader className="member-team-agent-card-header">
        <Avatar
          name={agent.displayName}
          src={agent.avatarImageUrl ?? binding.botAvatarUrl}
          colorToken={agent.avatarColorToken}
          seed={agent.uuid}
          size={40}
        />
        <CardTitle className="min-w-0 truncate">{agent.displayName}</CardTitle>
      </CardHeader>
      <CardContent className="member-team-agent-card-content">
        <p className="member-team-agent-responsibility">{responsibility}</p>
      </CardContent>
      <CardFooter className="member-team-agent-card-footer">
        <Button asChild className="w-full">
          <a href={feishuBotChatUrl(binding.appId)} target="_blank" rel="noreferrer">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Message in Feishu
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

function EmptyTeamAgents({ teamName }: { teamName: string }): ReactElement {
  return (
    <section className="member-team-agents-empty" aria-labelledby="team-agents-empty-title">
      <div className="member-team-agents-empty-icon" aria-hidden="true">
        <MessageCircle className="h-5 w-5" />
      </div>
      <h2 id="team-agents-empty-title" className="text-subtitle font-semibold">
        You’re in {teamName}
      </h2>
      <p className="text-body">
        No team agents are ready in Feishu yet. Check with your team admins to find out what’s available.
      </p>
    </section>
  );
}

function GroupUseHint(): ReactElement {
  return (
    <p className="member-team-agents-group-hint">
      Want to use an agent in a group? In Feishu, search for the agent by name, add it to the group, then @mention it.
    </p>
  );
}
