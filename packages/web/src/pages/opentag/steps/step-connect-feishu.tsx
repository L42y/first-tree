import type { FeishuBotBinding } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { FeishuRegistrationQr } from "../../../features/feishu/binding-view.js";
import { FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/** Bot creation, official confirmation, and genuine reachability only. */
export function StepConnectFeishu({
  agentDisplayName,
  binding,
  loading,
  readFailed,
  onRetryRead,
  starting,
  error,
  onConnect,
}: {
  agentDisplayName: string;
  binding: FeishuBotBinding | null;
  loading: boolean;
  readFailed: boolean;
  onRetryRead: () => void;
  starting: boolean;
  error: string | null;
  onConnect: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <LabeledDetail label="Agent">{agentDisplayName}</LabeledDetail>
      <FeishuBody
        binding={binding}
        loading={loading}
        readFailed={readFailed}
        onRetryRead={onRetryRead}
        starting={starting}
        onConnect={onConnect}
      />
      {error ? (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      ) : null}
    </div>
  );
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
          We couldn't check whether this agent already has a bot.
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
        Checking for a bot…
      </p>
    );
  }

  if (!binding) {
    return (
      <div className="flex">
        <Button type="button" variant="cta" disabled={starting} onClick={onConnect}>
          <span>{starting ? "Preparing…" : "Add OpenTag to Feishu"}</span>
          {!starting ? <ArrowRight className="h-4 w-4" /> : null}
        </Button>
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
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <FeishuRegistrationQr registrationUrl={binding.registrationUrl} />
        <StatusRow state="waiting" label="Waiting for Feishu to confirm the bot…" />
      </div>
    );
  }

  if (binding.connectionStatus === "error") {
    return (
      <FlowHint tone="error" role="alert">
        {binding.lastErrorMessage ?? "The bot is set up but its connection to Feishu is failing."}
      </FlowHint>
    );
  }

  return (
    <StatusRow
      state="waiting"
      label={
        binding.status === "active"
          ? "The bot is set up and connecting to Feishu…"
          : "Waiting for Feishu to confirm the bot…"
      }
    />
  );
}

function LabeledDetail({ label, children }: { label: string; children: string }): ReactElement {
  return (
    <div>
      <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-2)" }}>
        {label}
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {children}
      </p>
    </div>
  );
}
