import { type Agent, type FeishuBotBinding, hasCurrentFeishuRequiredScopes } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleMinus, Clock3, MessageSquare, QrCode, Unplug } from "lucide-react";
import {
  createAgentFeishuSetupChat,
  revokeAgentFeishuBinding,
  startAgentFeishuRegistration,
} from "../../api/agents.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Section } from "../../components/ui/section.js";
import {
  FeishuRegistrationQr,
  feishuBindingLabel,
  feishuBindingQueryKey,
  feishuBindingQueryOptions,
  isFeishuBotReachable,
  isFeishuHandoffUsable,
} from "../../features/feishu/binding-view.js";
import { ConfigRow } from "./flat-section.js";
import { useAgentDetailContext } from "./layout-context.js";

type FeishuSectionProps = {
  onOpenProfile?: () => void;
  /** Visual previews seed a fixed binding and must not start ambient API polling. */
  poll?: boolean;
};

export type FeishuChannelState = "not-connected" | "setup-incomplete" | "ready" | "needs-attention";

/**
 * One user-value verdict for the whole channel. A reachable Bot is only half
 * of the promise: the Agent also needs its official CLI before it can reply.
 * The live connection, current permission bundle, and CLI capability must all
 * hold before a surface promises that the handoff can carry work.
 */
export function feishuChannelState(binding: FeishuBotBinding | null, agentStatus: Agent["status"]): FeishuChannelState {
  if (agentStatus !== "active") return "needs-attention";
  if (!binding) return "not-connected";
  if (binding.status === "error" || binding.connectionStatus === "error" || binding.cli.state === "offline") {
    return "needs-attention";
  }
  if (isFeishuHandoffUsable(binding)) return "ready";
  return "setup-incomplete";
}

function VisibilityRequirement({ onOpenProfile }: FeishuSectionProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" style={{ padding: "var(--sp-3) 0" }}>
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Organization visibility is required
        </div>
        <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
          Only organization-visible Agents can connect to a Feishu Bot.
        </div>
      </div>
      {onOpenProfile && (
        <Button size="xs" variant="outline" onClick={onOpenProfile}>
          Manage in Profile
        </Button>
      )}
    </div>
  );
}

function ChannelSummary({ binding, agentStatus }: { binding: FeishuBotBinding | null; agentStatus: Agent["status"] }) {
  const state = feishuChannelState(binding, agentStatus);
  const presentation = (() => {
    switch (state) {
      case "not-connected":
        return {
          icon: CircleMinus,
          color: "var(--fg-4)",
          title: "Not connected",
          detail: "Teammates can't reach this Agent in Feishu yet.",
        };
      case "ready":
        return {
          icon: CircleCheck,
          color: "var(--success)",
          title: "Ready for Feishu tasks",
          detail: "The Bot is reachable, and this Agent can reply from its Computer.",
        };
      case "needs-attention":
        return {
          icon: CircleAlert,
          color: "var(--state-needs-you)",
          title: agentStatus === "suspended" ? "Agent is suspended" : "Needs attention",
          detail:
            agentStatus === "suspended"
              ? "Reactivate this Agent in Profile before teammates send it a Feishu task."
              : (binding?.lastErrorMessage ??
                (binding?.cli.state === "offline"
                  ? "The Bot may still receive messages, but this Agent's Computer is offline and can't reply."
                  : "The Feishu channel needs action before this Agent can handle a task.")),
        };
      case "setup-incomplete":
        return {
          icon: Clock3,
          color: "var(--state-idle)",
          title: "Setup incomplete",
          detail:
            binding && !hasCurrentFeishuRequiredScopes(binding.grantedScopes)
              ? "The Bot is online with its existing access. Update permissions to enable replies and thread context."
              : binding && isFeishuBotReachable(binding)
                ? "The Bot is reachable. Finish the Agent setup before teammates send it a task."
                : "Finish connecting the Bot before teammates send this Agent a task.",
        };
    }
  })();
  const StatusIcon = presentation.icon;

  return (
    <div
      className="flex items-start gap-3"
      data-channel-state={state}
      style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}
    >
      <StatusIcon className="h-5 w-5 shrink-0" aria-hidden="true" style={{ color: presentation.color }} />
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {presentation.title}
        </div>
        <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
          {presentation.detail}
        </div>
      </div>
    </div>
  );
}

export function FeishuSection({ onOpenProfile, poll = true }: FeishuSectionProps = {}) {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const queryOptions = feishuBindingQueryOptions(ctx.uuid);
  const query = useQuery({
    ...queryOptions,
    enabled: !ctx.isHuman,
    refetchInterval: poll ? queryOptions.refetchInterval : false,
  });
  const binding = query.data?.binding ?? null;
  const canConnect = ctx.agent.visibility === "organization";
  const visibilityBlocked = !canConnect && (!binding || binding.status === "error");
  const refresh = () => queryClient.invalidateQueries({ queryKey: feishuBindingQueryKey(ctx.uuid) });
  const start = useMutation({
    mutationFn: () => startAgentFeishuRegistration(ctx.uuid, `${ctx.agent.displayName} · First Tree`),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: () => revokeAgentFeishuBinding(ctx.uuid),
    onSuccess: refresh,
  });
  const setup = useMutation({
    // Pressing this is the member asking, not a surface ensuring: the Agent may
    // have finished with the original request long ago, so a repair that only
    // reused the Task would send them into a conversation where nothing happens.
    mutationFn: () => createAgentFeishuSetupChat(ctx.uuid, { retry: true }),
    onSuccess: ({ chatId }) => ctx.navigateAway(`/?c=${encodeURIComponent(chatId)}`),
  });
  const mutationError = start.error ?? revoke.error ?? setup.error;

  return (
    <Section
      headingLevel={3}
      title="Feishu"
      description="Teammates reach this Agent through its dedicated Feishu Bot."
      action={
        ctx.canManageAgent && !query.isLoading && !query.isError && !binding ? (
          <Button size="xs" variant="outline" disabled={start.isPending || !canConnect} onClick={() => start.mutate()}>
            <QrCode className="h-3.5 w-3.5" /> {start.isPending ? "Preparing…" : "Connect Bot"}
          </Button>
        ) : null
      }
    >
      {query.isLoading ? (
        <div className="text-body" role="status" style={{ padding: "var(--sp-3) 0", color: "var(--fg-3)" }}>
          Checking Feishu channel…
        </div>
      ) : query.isError && !query.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3" style={{ padding: "var(--sp-3) 0" }}>
          <div role="alert">
            <div className="text-body font-medium" style={{ color: "var(--state-error)" }}>
              Couldn't check this channel
            </div>
            <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
              {query.error instanceof Error ? query.error.message : "Feishu status is unavailable."}
            </div>
          </div>
          <Button size="xs" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : (
        <>
          <ChannelSummary binding={binding} agentStatus={ctx.agent.status} />
          {visibilityBlocked && <VisibilityRequirement onOpenProfile={onOpenProfile} />}
        </>
      )}
      {!query.isLoading && !query.isError && !binding ? (
        canConnect ? (
          <div className="text-body" style={{ padding: "var(--sp-3) 0", color: "var(--fg-3)" }}>
            First Tree will prepare the app and show a QR code; you only confirm it in Feishu.
          </div>
        ) : null
      ) : binding ? (
        <>
          <ConfigRow
            label="Bot"
            value={
              binding.botName ? (
                <span className="flex min-w-0 items-center gap-2">
                  {binding.botAvatarUrl && (
                    <img
                      src={binding.botAvatarUrl}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-[var(--radius-chip)] object-cover"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <span className="truncate">{binding.botName}</span>
                </span>
              ) : binding.appId ? (
                <span className="mono">{binding.appId}</span>
              ) : (
                "Creating app…"
              )
            }
            description={
              (binding.botName && binding.appId) || binding.lastErrorMessage ? (
                <span className="flex flex-col gap-1">
                  {binding.botName && binding.appId && (
                    <span>
                      App ID: <span className="mono">{binding.appId}</span>
                    </span>
                  )}
                  {binding.lastErrorMessage && <span>{binding.lastErrorMessage}</span>}
                </span>
              ) : undefined
            }
            meta={
              <DenseBadge
                tone={
                  binding.status === "error" || binding.connectionStatus === "error"
                    ? "error"
                    : isFeishuBotReachable(binding)
                      ? "accent"
                      : "warn"
                }
              >
                {feishuBindingLabel(binding.status, binding.connectionStatus)}
              </DenseBadge>
            }
            action={
              ctx.canManageAgent ? (
                <div className="flex gap-1">
                  {binding.status === "active" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={start.isPending || !canConnect}
                      onClick={() => start.mutate()}
                    >
                      <QrCode className="h-3.5 w-3.5" /> Update permissions
                    </Button>
                  )}
                  {binding.status === "error" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={start.isPending || !canConnect}
                      onClick={() => start.mutate()}
                    >
                      Retry
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (window.confirm("Disconnect this Feishu Bot? Existing task history will be kept."))
                        revoke.mutate();
                    }}
                  >
                    <Unplug className="h-3.5 w-3.5" /> Disconnect
                  </Button>
                </div>
              ) : null
            }
          />
          {!hasCurrentFeishuRequiredScopes(binding.grantedScopes) && (
            <ConfigRow
              label="Permissions"
              value="Update required"
              description="Allow this Bot to receive group replies, continue active threads, and load bounded chat context."
              meta={<DenseBadge tone="warn">Action needed</DenseBadge>}
            />
          )}
          {ctx.canManageAgent && binding.registrationUrl && binding.status === "provisioning" && (
            <FeishuRegistrationQr registrationUrl={binding.registrationUrl} />
          )}
          {(binding.status === "active" ||
            (binding.status === "provisioning" &&
              binding.connectionStatus === "connected" &&
              binding.appId !== null &&
              binding.botOpenId !== null)) && (
            <ConfigRow
              label="Feishu CLI"
              value={
                binding.cli.state === "ready"
                  ? `Ready${binding.cli.version ? ` · ${binding.cli.version}` : ""}`
                  : binding.cli.state === "offline"
                    ? "Computer offline"
                    : "Not detected"
              }
              description="This Agent uses the official Feishu CLI on its Computer to reply to tasks."
              action={
                ctx.canManageAgent && binding.cli.state !== "ready" ? (
                  <Button size="xs" variant="outline" disabled={setup.isPending} onClick={() => setup.mutate()}>
                    <MessageSquare className="h-3.5 w-3.5" /> {setup.isPending ? "Opening…" : "Ask Agent to install"}
                  </Button>
                ) : null
              }
            />
          )}
        </>
      ) : null}
      {mutationError && (
        <div className="text-caption" role="alert" style={{ color: "var(--state-error)", padding: "var(--sp-2) 0" }}>
          {mutationError instanceof Error ? mutationError.message : "Feishu setup failed."}
        </div>
      )}
    </Section>
  );
}
