import type { FeishuBotBinding } from "@first-tree/shared";
import { QrCode } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { DenseBadge } from "../../../components/ui/dense-badge.js";
import {
  FeishuRegistrationQr,
  feishuBindingLabel,
  isFeishuBotReachable,
} from "../../../features/feishu/binding-view.js";
import { FlowHint } from "../../onboarding/flow-ui.js";

/**
 * The focused Feishu step: one Bot for this one Agent.
 *
 * It reuses the Feishu integration's own binding read and registration QR
 * rather than re-explaining them, and it deliberately is NOT the Agent Detail
 * Profile page — a member who came through OpenTag should not have to find the
 * right section of a configuration surface to finish the handoff.
 *
 * Reaching a connected Bot does not complete onboarding: real first use in
 * Feishu is what turns this into work, and that happens in Feishu.
 */
export function StepConnectFeishu({
  agentDisplayName,
  agentUuid,
  binding,
  loading,
  readFailed,
  onRetryRead,
  starting,
  error,
  onConnect,
}: {
  agentDisplayName: string;
  agentUuid: string;
  binding: FeishuBotBinding | null;
  loading: boolean;
  /** The binding read failed, so the absence of a Bot is not established. */
  readFailed: boolean;
  onRetryRead: () => void;
  starting: boolean;
  error: string | null;
  onConnect: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <div
        className="flex flex-col"
        style={{
          gap: "var(--sp-3)",
          padding: "var(--sp-3_5)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
        }}
      >
        <div className="flex items-start justify-between" style={{ gap: "var(--sp-3)" }}>
          <div className="min-w-0">
            <p className="text-body font-medium" style={{ margin: 0, color: "var(--fg)" }}>
              Feishu Bot for {agentDisplayName}
            </p>
            <p className="text-caption" style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}>
              One Bot and one Feishu chat map to one First Tree task.
            </p>
          </div>
          {binding && (
            <DenseBadge tone={badgeTone(binding)}>
              {feishuBindingLabel(binding.status, binding.connectionStatus)}
            </DenseBadge>
          )}
        </div>

        <FeishuBody
          binding={binding}
          loading={loading}
          readFailed={readFailed}
          onRetryRead={onRetryRead}
          starting={starting}
          onConnect={onConnect}
        />
      </div>

      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}

      {/* Always available: the Agent exists and is running, so its own page is
          a real destination even before the Bot is confirmed. */}
      <div className="flex">
        <Button type="button" variant="outline" asChild>
          <a href={`/agents/${encodeURIComponent(agentUuid)}/profile`}>Open Agent settings</a>
        </Button>
      </div>
    </div>
  );
}

/**
 * Only a Bot that is both provisioned AND connected earns the success tone.
 * `status: "active"` alone means the Feishu app exists, not that messages can
 * reach the Agent.
 */
function badgeTone(binding: FeishuBotBinding): "error" | "accent" | "warn" {
  if (binding.status === "error" || binding.connectionStatus === "error") return "error";
  return isFeishuBotReachable(binding) ? "accent" : "warn";
}

function FeishuBody({
  binding,
  loading,
  readFailed,
  onRetryRead,
  starting,
  onConnect,
}: {
  binding: FeishuBotBinding | null;
  loading: boolean;
  readFailed: boolean;
  onRetryRead: () => void;
  starting: boolean;
  onConnect: () => void;
}): ReactElement {
  if (readFailed && !binding) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <FlowHint tone="error" role="alert">
          We couldn't check whether this Agent already has a Bot.
        </FlowHint>
        <div className="flex">
          <Button type="button" variant="outline" onClick={onRetryRead}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (loading && !binding) {
    return (
      <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
        Checking for a Bot…
      </p>
    );
  }

  if (!binding) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          First Tree prepares the Feishu app and shows a QR code. You only confirm it in Feishu.
        </p>
        <div className="flex">
          <Button type="button" variant="cta" disabled={starting} onClick={onConnect}>
            <QrCode className="h-4 w-4" />
            <span>{starting ? "Preparing…" : "Connect Bot"}</span>
          </Button>
        </div>
      </div>
    );
  }

  if (binding.status === "error") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <FlowHint tone="error" role="alert">
          {binding.lastErrorMessage ?? "Feishu setup could not finish."}
        </FlowHint>
        <div className="flex">
          <Button type="button" variant="outline" disabled={starting} onClick={onConnect}>
            {starting ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  if (binding.status === "provisioning" && binding.registrationUrl) {
    return <FeishuRegistrationQr registrationUrl={binding.registrationUrl} />;
  }

  if (isFeishuBotReachable(binding)) {
    return (
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        The Bot is connected. Message it in Feishu — a private message or an exact group mention starts the first task.
      </p>
    );
  }

  // A provisioned Bot whose connection is down is a failure, not a wait, and
  // has to say so in words — the badge colour alone is not the message.
  if (binding.connectionStatus === "error") {
    return (
      <FlowHint tone="error" role="alert">
        {binding.lastErrorMessage ?? "The Bot is set up but its connection to Feishu is failing."}
      </FlowHint>
    );
  }

  // Provisioned but not reachable yet, or waiting for the Feishu confirmation.
  // Saying "connected" here would promise a channel that does not carry
  // messages yet.
  return (
    <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
      {binding.status === "active"
        ? "The Bot is set up and connecting to Feishu…"
        : "Waiting for Feishu to confirm the Bot…"}
    </p>
  );
}
