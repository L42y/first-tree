import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquare, QrCode, Unplug } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  createAgentFeishuSetupChat,
  getAgentFeishuBinding,
  revokeAgentFeishuBinding,
  startAgentFeishuRegistration,
} from "../../api/agents.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Section } from "../../components/ui/section.js";
import { ConfigRow } from "./flat-section.js";
import { useAgentDetailContext } from "./layout-context.js";

function bindingLabel(status: string, connectionStatus: string): string {
  if (status === "active" && connectionStatus === "connected") return "Connected";
  if (status === "provisioning") return "Waiting for confirmation";
  if (status === "error") return "Needs attention";
  return status;
}

export function FeishuSection() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agent-feishu-binding", ctx.uuid],
    queryFn: () => getAgentFeishuBinding(ctx.uuid),
    enabled: !ctx.isHuman,
    refetchInterval: (state) => (state.state.data?.binding?.status === "provisioning" ? 2_000 : 10_000),
  });
  const binding = query.data?.binding ?? null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-feishu-binding", ctx.uuid] });
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
      description="Connect a dedicated Feishu Bot to this Agent. One Bot and Feishu chat map to one First Tree task."
      action={
        ctx.canManageAgent && !binding ? (
          <Button size="xs" variant="outline" disabled={start.isPending} onClick={() => start.mutate()}>
            <QrCode className="h-3.5 w-3.5" /> {start.isPending ? "Preparing…" : "Connect Bot"}
          </Button>
        ) : null
      }
    >
      {!binding ? (
        <div className="text-body" style={{ padding: "var(--sp-3) 0", color: "var(--fg-3)" }}>
          No Feishu Bot is connected. First Tree will prepare the app and show a QR code; you only confirm in Feishu.
        </div>
      ) : (
        <>
          <ConfigRow
            label="Bot"
            value={binding.appId ? <span className="mono">{binding.appId}</span> : "Creating app…"}
            description={binding.lastErrorMessage ?? undefined}
            meta={
              <DenseBadge tone={binding.status === "error" ? "error" : binding.status === "active" ? "accent" : "warn"}>
                {bindingLabel(binding.status, binding.connectionStatus)}
              </DenseBadge>
            }
            action={
              ctx.canManageAgent ? (
                <div className="flex gap-1">
                  {binding.status === "error" && (
                    <Button size="xs" variant="outline" disabled={start.isPending} onClick={() => start.mutate()}>
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
            <div className="flex flex-col items-center gap-3" style={{ padding: "var(--sp-4) 0" }}>
              <QRCodeSVG
                value={binding.registrationUrl}
                size={184}
                marginSize={2}
                title="Feishu Bot registration QR code"
              />
              <div className="text-label text-center" style={{ color: "var(--fg-3)" }}>
                Scan with Feishu and confirm creating the Bot. This page updates automatically.
              </div>
              <Button size="xs" variant="outline" asChild>
                <a href={binding.registrationUrl} target="_blank" rel="noreferrer">
                  Open confirmation page <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
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
