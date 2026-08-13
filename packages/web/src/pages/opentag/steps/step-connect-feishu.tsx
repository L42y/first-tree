import type { FeishuBotBinding } from "@first-tree/shared";
import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, Clock3, QrCode } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { FeishuRegistrationQr, isFeishuBotReachable } from "../../../features/feishu/binding-view.js";
import { FlowHint } from "../../onboarding/flow-ui.js";
import { feishuStepCopy, OPENTAG_FEISHU_READINESS_COPY } from "../copy.js";
import {
  isFeishuHandoffUsable,
  type OpenTagFeishuStepState,
  type OpenTagToolsPrep,
  resolveFeishuBotState,
} from "../flow.js";

/**
 * The focused Feishu step: one Bot for this one Agent.
 *
 * It reuses the Feishu integration's own binding read and registration QR
 * rather than re-explaining them, and it deliberately is NOT the Agent Detail
 * Profile page — a member who came through OpenTag should not have to find the
 * right section of a configuration surface to finish the handoff.
 *
 * Committing to Feishu starts two independent waits: the member confirms the
 * Bot over in Feishu, and the Agent prepares the official CLI on its own
 * Computer. They are shown side by side because they genuinely run in
 * parallel, and neither is a step the member performs — installing tools is
 * something the Agent does for itself, so this surface never asks anyone to
 * understand or approve it.
 *
 * Reaching a connected Bot does not complete onboarding: real first use in
 * Feishu is what turns this into work, and that happens in Feishu — but only
 * once the Agent can actually reply, so the invitation to message the Bot is
 * withheld until both halves are ready.
 */
export function StepConnectFeishu({
  agentUuid,
  binding,
  loading,
  readFailed,
  onRetryRead,
  starting,
  error,
  onConnect,
  step,
  retrying,
  onRetryTools,
}: {
  agentUuid: string;
  binding: FeishuBotBinding | null;
  loading: boolean;
  /** The binding read failed, so the absence of a Bot is not established. */
  readFailed: boolean;
  onRetryRead: () => void;
  starting: boolean;
  error: string | null;
  onConnect: () => void;
  /** What this step is showing and what it offers the member. */
  step: OpenTagFeishuStepState;
  /** A member-triggered retry of the preparation is in flight. */
  retrying: boolean;
  onRetryTools: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col" data-opentag-step="connect-feishu" style={{ gap: "var(--sp-4)" }}>
      <div
        style={{
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
        }}
      >
        {binding ? (
          <div className="grid md:grid-cols-2">
            <div className="flex flex-col justify-center" style={{ gap: "var(--sp-3)", padding: "var(--sp-4)" }}>
              <BotColumn binding={binding} starting={starting} onConnect={onConnect} tools={step.tools} />
            </div>
            {/* The divider is horizontal while the columns are stacked, so the
                two waits never read as one continuous list on a phone. */}
            <div
              className="flex flex-col border-t md:border-t-0 md:border-l"
              style={{ gap: "var(--sp-3)", padding: "var(--sp-4)", borderColor: "var(--border)" }}
            >
              <ToolsPanel
                agentUuid={agentUuid}
                binding={binding}
                step={step}
                retrying={retrying}
                onRetryTools={onRetryTools}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)", padding: "var(--sp-4)" }}>
            <NoBotYet
              loading={loading}
              readFailed={readFailed}
              onRetryRead={onRetryRead}
              starting={starting}
              onConnect={onConnect}
            />
          </div>
        )}
      </div>

      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}
    </div>
  );
}

/**
 * Before the member commits to Feishu there is nothing to prepare and nothing
 * to report — only the one decision this step exists for.
 */
function NoBotYet({
  loading,
  readFailed,
  onRetryRead,
  starting,
  onConnect,
}: {
  loading: boolean;
  readFailed: boolean;
  onRetryRead: () => void;
  starting: boolean;
  onConnect: () => void;
}): ReactElement {
  if (readFailed) {
    return (
      <>
        <FlowHint tone="error" role="alert">
          We couldn't check whether this Agent already has a Bot.
        </FlowHint>
        <div className="flex">
          <Button type="button" variant="outline" onClick={onRetryRead}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
        Checking for a Bot…
      </p>
    );
  }

  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        First Tree prepares the Feishu app and shows a QR code. You only confirm it in Feishu.
      </p>
      <div className="flex">
        <Button type="button" variant="cta" disabled={starting} onClick={onConnect}>
          <QrCode className="h-4 w-4" />
          <span>{starting ? "Preparing…" : "Connect Bot"}</span>
        </Button>
      </div>
    </>
  );
}

/** The member's half of the handoff: confirming the Bot over in Feishu. */
function BotColumn({
  binding,
  starting,
  onConnect,
  tools,
}: {
  binding: FeishuBotBinding;
  starting: boolean;
  onConnect: () => void;
  tools: OpenTagToolsPrep;
}): ReactElement {
  if (binding.status === "error") {
    return (
      <>
        <FlowHint tone="error" role="alert">
          {binding.lastErrorMessage ?? "Feishu setup could not finish."}
        </FlowHint>
        <div className="flex">
          <Button type="button" variant="outline" disabled={starting} onClick={onConnect}>
            {starting ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </>
    );
  }

  if (binding.status === "provisioning" && binding.registrationUrl) {
    return <FeishuRegistrationQr registrationUrl={binding.registrationUrl} />;
  }

  if (isFeishuBotReachable(binding)) {
    return (
      <div className="flex flex-col items-center text-center" style={{ gap: "var(--sp-2_5)" }}>
        <CircleCheck className="h-6 w-6" aria-hidden="true" style={{ color: "var(--success)" }} />
        <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
          Feishu Bot connected
        </p>
        {/* The invitation to use the Bot is the last thing this step says, and
            only once the Agent could actually answer. Asking earlier would send
            the member to a chat that goes unanswered and, worse, let a first
            Task finish setup the Agent cannot yet deliver on. */}
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {isFeishuHandoffUsable(binding)
            ? "Message it in Feishu — a private message or an exact group mention starts the first task."
            : // "the rest finishes" is only true while something still is
              // finishing. Nothing is, once preparation failed or has no
              // Computer to run on.
              tools.state === "preparing" || (tools.state === "recoverable" && tools.reason === "slow")
              ? "Your Bot and its permissions are kept while the rest finishes."
              : "Your Bot and its permissions are kept."}
        </p>
      </div>
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

/**
 * The Agent's half: what it is preparing on its own Computer, and — only once
 * waiting has stopped being reasonable — what the member can do about it.
 */
function ToolsPanel({
  agentUuid,
  binding,
  step,
  retrying,
  onRetryTools,
}: {
  agentUuid: string;
  binding: FeishuBotBinding;
  step: OpenTagFeishuStepState;
  retrying: boolean;
  onRetryTools: () => void;
}): ReactElement {
  const copy = OPENTAG_FEISHU_READINESS_COPY;
  // The same derivation the page heading uses, so the two cannot disagree.
  const header = feishuStepCopy(resolveFeishuBotState(binding), step.tools).panel;

  return (
    <>
      {header && (
        <div>
          <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
            {header.title}
          </p>
          <p className="text-caption" style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}>
            {header.lead}
          </p>
        </div>
      )}

      <div style={{ borderTop: "var(--hairline) solid var(--border-faint)" }}>
        <ReadinessRow label={copy.botLabel} readiness={botReadiness(binding)} />
        <ReadinessRow label={copy.toolsLabel} readiness={toolsReadiness(binding, step.tools)} />
      </div>

      {step.recovery === "offered" && (
        <>
          <div
            style={{
              padding: "var(--sp-2_5) var(--sp-3)",
              borderRadius: "var(--radius-input)",
              background: "var(--state-needs-you-soft)",
              color: "var(--fg-needs-you-strong)",
            }}
          >
            <p className="text-label font-semibold" style={{ margin: 0 }}>
              {copy.recoveryTitle}
            </p>
            <p className="text-label" style={{ margin: "var(--sp-0_5) 0 0" }}>
              {step.canRetryTools ? copy.recoveryLead : copy.recoveryLeadFinishOnly}
            </p>
          </div>
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            {step.canRetryTools && (
              <Button type="button" disabled={retrying} onClick={onRetryTools}>
                {retrying ? "Trying…" : copy.tryAgain}
              </Button>
            )}
            {/* Leaving is a real outcome, not an escape hatch: the Agent keeps
                preparing, and the Agent's own page is where this can be picked
                up again for good. Onboarding stays unfinished on purpose. */}
            <Button type="button" variant="ghost" asChild>
              <a href={`/agents/${encodeURIComponent(agentUuid)}/profile`}>{copy.finishLater}</a>
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** One capability the member is waiting on, in the Setup readiness vocabulary. */
type Readiness = {
  tone: "ready" | "pending" | "attention";
  /** The short right-aligned verdict. */
  status: string;
  detail: string;
};

const READINESS_PRESENTATION: Record<Readiness["tone"], { icon: LucideIcon; color: string }> = {
  ready: { icon: CircleCheck, color: "var(--success)" },
  pending: { icon: Clock3, color: "var(--state-idle)" },
  attention: { icon: CircleAlert, color: "var(--state-needs-you)" },
};

function ReadinessRow({ label, readiness }: { label: string; readiness: Readiness }): ReactElement {
  const StatusIcon = READINESS_PRESENTATION[readiness.tone].icon;
  return (
    <div
      className="flex items-start"
      data-readiness={readiness.tone}
      style={{
        gap: "var(--sp-2_5)",
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <StatusIcon
        className="h-4 w-4 shrink-0"
        aria-hidden="true"
        style={{ marginTop: "var(--sp-0_5)", color: READINESS_PRESENTATION[readiness.tone].color }}
      />
      <span className="min-w-0 flex-1">
        <span className="text-body block font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </span>
        <span className="text-caption block" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
          {readiness.detail}
        </span>
      </span>
      <span className="text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
        {readiness.status}
      </span>
    </div>
  );
}

/**
 * The Bot half, read from the binding the Feishu integration already owns.
 * `status: "active"` alone is not reachable — the socket may still be coming
 * up or down — so "ready" needs both fields.
 */
function botReadiness(binding: FeishuBotBinding): Readiness {
  if (binding.status === "error") {
    return {
      tone: "attention",
      status: "needs you",
      detail: binding.lastErrorMessage ?? "Feishu setup could not finish.",
    };
  }
  if (binding.connectionStatus === "error") {
    return {
      tone: "attention",
      status: "needs you",
      detail: binding.lastErrorMessage ?? "The connection to Feishu is failing.",
    };
  }
  if (isFeishuBotReachable(binding)) return { tone: "ready", status: "ready", detail: "Connected and reachable" };
  // An ordinary wait is not a verdict. "Not ready" is saved for the states
  // where something is actually outstanding for the member to act on.
  if (binding.status === "provisioning") {
    return { tone: "pending", status: "waiting", detail: "Waiting for your confirmation" };
  }
  return { tone: "pending", status: "connecting", detail: "Finishing the connection to Feishu" };
}

/**
 * The Agent half. The nuance the member can act on lives in the preparation
 * state, not in the raw capability enum: "missing" and "unknown" both mean the
 * Agent cannot call Feishu yet, and what differs is whether waiting is still
 * the right thing to do.
 */
function toolsReadiness(binding: FeishuBotBinding, tools: OpenTagToolsPrep): Readiness {
  if (tools.state === "ready") {
    return {
      tone: "ready",
      status: "ready",
      detail: binding.cli.version ? `Ready on this Computer · ${binding.cli.version}` : "Ready on this Computer",
    };
  }
  if (tools.state === "unavailable") {
    return { tone: "attention", status: "not ready", detail: "This Agent has no Computer yet." };
  }
  if (tools.state === "recoverable") {
    return {
      tone: "attention",
      status: "not ready",
      detail: tools.reason === "failed" ? "The automatic setup didn't start." : "Taking longer than usual.",
    };
  }
  return { tone: "pending", status: "preparing", detail: "Preparing this Computer in the background" };
}
