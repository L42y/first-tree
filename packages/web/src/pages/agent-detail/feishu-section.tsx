import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, QrCode, Unplug } from "lucide-react";
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
} from "../../features/feishu/binding-view.js";
import { ConfigRow } from "./flat-section.js";
import { useAgentDetailContext } from "./layout-context.js";

type FeishuSectionProps = {
  onOpenProfileEdit?: () => void;
};

function VisibilityRequirement({ onOpenProfileEdit }: FeishuSectionProps) {
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
      {onOpenProfileEdit && (
        <Button size="xs" variant="outline" onClick={onOpenProfileEdit}>
          Change visibility
        </Button>
      )}
    </div>
  );
}

export function FeishuSection({ onOpenProfileEdit }: FeishuSectionProps = {}) {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const query = useQuery({ ...feishuBindingQueryOptions(ctx.uuid), enabled: !ctx.isHuman });
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
    mutationFn: () => createAgentFeishuSetupChat(ctx.uuid),
    onSuccess: ({ chatId }) => ctx.navigateAway(`/?c=${encodeURIComponent(chatId)}`),
  });
  const error = start.error ?? revoke.error ?? setup.error ?? query.error;

  return (
    <Section
      headingLevel={3}
      title="Feishu"
      description="Connect a dedicated Feishu Bot to this Agent."
      action={
        ctx.canManageAgent && !binding ? (
          <Button size="xs" variant="outline" disabled={start.isPending || !canConnect} onClick={() => start.mutate()}>
            <QrCode className="h-3.5 w-3.5" /> {start.isPending ? "Preparing…" : "Connect Bot"}
          </Button>
        ) : null
      }
    >
      {visibilityBlocked && <VisibilityRequirement onOpenProfileEdit={onOpenProfileEdit} />}
      {!binding ? (
        canConnect ? (
          <div className="text-body" style={{ padding: "var(--sp-3) 0", color: "var(--fg-3)" }}>
            No Feishu Bot is connected. First Tree will prepare the app and show a QR code; you only confirm in Feishu.
          </div>
        ) : null
      ) : (
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
              <DenseBadge tone={binding.status === "error" ? "error" : binding.status === "active" ? "accent" : "warn"}>
                {feishuBindingLabel(binding.status, binding.connectionStatus)}
              </DenseBadge>
            }
            action={
              ctx.canManageAgent ? (
                <div className="flex gap-1">
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
          {ctx.canManageAgent && binding.registrationUrl && binding.status === "provisioning" && (
            <FeishuRegistrationQr registrationUrl={binding.registrationUrl} />
          )}
          {binding.status === "active" && (
            <ConfigRow
              label="Feishu CLI"
              value={
                binding.cli.state === "ready"
                  ? `Ready${binding.cli.version ? ` · ${binding.cli.version}` : ""}`
                  : binding.cli.state === "offline"
                    ? "Computer offline"
                    : "Not detected"
              }
              description="The Agent records outbound intent in First Tree, then calls the official lark-cli directly with a temporary Bot credential environment."
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
      )}
      {error && (
        <div className="text-caption" role="alert" style={{ color: "var(--state-error)", padding: "var(--sp-2) 0" }}>
          {error instanceof Error ? error.message : "Feishu setup failed."}
        </div>
      )}
    </Section>
  );
}
