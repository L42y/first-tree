import type { ContextIntegrationProvider } from "@first-tree/shared";
import { Check, Clipboard, FileText, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generateConnectToken } from "../../api/activity.js";
import { getContextEnablementHandoff } from "../../api/context-enablement.js";
import { Button } from "../../components/ui/button.js";
import { buildByoSetupPrompt } from "../../lib/byo-setup-prompt.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";

const PROVIDERS: Array<{ id: ContextIntegrationProvider; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export function OnboardingContextPersonalAccess({ organizationId, ready }: { organizationId: string; ready: boolean }) {
  const [provider, setProvider] = useState<ContextIntegrationProvider>("claude-code");
  const copyFeedback = useCopyFeedback();
  const [prepareState, setPrepareState] = useState<"idle" | "loading" | "failed">("idle");
  const prepareAttempt = useRef(0);
  const activeSelection = useRef({ organizationId, provider, ready });
  activeSelection.current = { organizationId, provider, ready };

  useEffect(() => {
    const renderedSelection = { organizationId, provider, ready };
    prepareAttempt.current += 1;
    setPrepareState("idle");
    copyFeedback.reset();
    return () => {
      const current = activeSelection.current;
      if (
        current.organizationId === renderedSelection.organizationId &&
        current.provider === renderedSelection.provider &&
        current.ready === renderedSelection.ready
      ) {
        prepareAttempt.current += 1;
      }
    };
  }, [copyFeedback.reset, organizationId, provider, ready]);

  if (!ready) return null;

  return (
    <section
      id="context-access"
      aria-labelledby="context-access-title"
      style={{
        margin: "var(--sp-5)",
        padding: "var(--sp-5)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
      }}
    >
      <div className="flex items-start" style={{ gap: "var(--sp-3)" }}>
        <FileText className="h-4 w-4 shrink-0" aria-hidden style={{ marginTop: "var(--sp-1)", color: "var(--fg-3)" }} />
        <div className="min-w-0 flex-1">
          <h2 id="context-access-title" className="text-body font-medium" style={{ margin: 0 }}>
            Use Team Context in your coding agent
          </h2>
          <p className="text-caption" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-3)" }}>
            Optional · Copy one setup prompt into Claude Code or Codex. That conversation stays outside First Tree Chat.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}>
        {PROVIDERS.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={provider === item.id ? "default" : "outline"}
            size="sm"
            aria-pressed={provider === item.id}
            onClick={() => setProvider(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {prepareState === "failed" ? (
        <p role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          Could not prepare the setup prompt.
        </p>
      ) : null}
      {copyFeedback.status === "failed" ? (
        <p role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          Could not copy the setup prompt.
        </p>
      ) : null}

      <div style={{ marginTop: "var(--sp-3)" }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={prepareState === "loading"}
          onClick={() => {
            const attempt = ++prepareAttempt.current;
            const selectedProvider = provider;
            void (async () => {
              setPrepareState("loading");
              copyFeedback.reset();
              try {
                const prompt = await prepareOnboardingByoSetupPrompt(organizationId, selectedProvider);
                const current = activeSelection.current;
                if (
                  prepareAttempt.current !== attempt ||
                  current.organizationId !== organizationId ||
                  current.provider !== selectedProvider ||
                  !current.ready
                ) {
                  return;
                }
                setPrepareState("idle");
                await copyFeedback.copy(prompt);
              } catch {
                const current = activeSelection.current;
                if (
                  prepareAttempt.current !== attempt ||
                  current.organizationId !== organizationId ||
                  current.provider !== selectedProvider ||
                  !current.ready
                ) {
                  return;
                }
                setPrepareState("failed");
              }
            })();
          }}
        >
          {prepareState === "failed" ? (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          ) : copyFeedback.status === "copied" ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Clipboard className="h-3.5 w-3.5" aria-hidden />
          )}
          {prepareState === "loading"
            ? "Preparing…"
            : prepareState === "failed"
              ? "Retry"
              : copyFeedback.status === "copied"
                ? "Copied"
                : copyFeedback.status === "failed"
                  ? "Copy failed"
                  : "Copy setup prompt"}
        </Button>
      </div>
    </section>
  );
}

export async function prepareOnboardingByoSetupPrompt(
  organizationId: string,
  provider: ContextIntegrationProvider,
): Promise<string> {
  const [bootstrap, handoff] = await Promise.all([
    generateConnectToken(),
    getContextEnablementHandoff(organizationId, provider),
  ]);
  if (handoff.provider !== provider) {
    throw new Error("BYO setup handoff does not match the selected provider");
  }
  return buildByoSetupPrompt({
    organizationId,
    bootstrapCommand: bootstrap.bootstrapCommand,
    handoffs: [handoff],
    intent: "onboarding",
  });
}

export async function prepareSettingsByoSetupPrompt(organizationId: string): Promise<string> {
  const [bootstrap, claudeHandoff, codexHandoff] = await Promise.all([
    generateConnectToken(),
    getContextEnablementHandoff(organizationId, "claude-code"),
    getContextEnablementHandoff(organizationId, "codex"),
  ]);
  return buildByoSetupPrompt({
    organizationId,
    bootstrapCommand: bootstrap.bootstrapCommand,
    handoffs: [claudeHandoff, codexHandoff],
    intent: "settings",
  });
}

export function ContextPersonalAccess({
  organizationId,
  preparePrompt = prepareSettingsByoSetupPrompt,
}: {
  organizationId: string;
  preparePrompt?: (organizationId: string) => Promise<string>;
}) {
  const copyFeedback = useCopyFeedback();
  const [prepareState, setPrepareState] = useState<"idle" | "loading" | "failed">("idle");
  const prepareAttempt = useRef(0);
  const activeOrganizationId = useRef(organizationId);
  activeOrganizationId.current = organizationId;
  const copyLabel =
    copyFeedback.status === "copied"
      ? "Copied"
      : copyFeedback.status === "failed"
        ? "Copy failed"
        : "Copy setup prompt";

  useEffect(() => {
    const renderedOrganizationId = organizationId;
    prepareAttempt.current += 1;
    setPrepareState("idle");
    copyFeedback.reset();
    return () => {
      if (activeOrganizationId.current === renderedOrganizationId) {
        prepareAttempt.current += 1;
      }
    };
  }, [copyFeedback.reset, organizationId]);

  return (
    <div
      data-setup-personal-access
      className="flex flex-wrap items-center justify-between"
      style={{ gap: "var(--sp-3)" }}
    >
      <div className="min-w-0" style={{ flex: "1 1 28rem" }}>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Use in your coding agent
        </div>
        <div className="text-label" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
          Personal access · Work with this Team Context from Claude Code or Codex, outside First Tree Chat.
        </div>
        {prepareState === "failed" ? (
          <div role="alert" className="text-label" style={{ marginTop: "var(--sp-2)", color: "var(--state-error)" }}>
            Could not prepare the setup prompt.
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={prepareState === "loading"}
        onClick={() => {
          const attempt = ++prepareAttempt.current;
          void (async () => {
            setPrepareState("loading");
            copyFeedback.reset();
            try {
              const prompt = await preparePrompt(organizationId);
              if (prepareAttempt.current !== attempt || activeOrganizationId.current !== organizationId) return;
              setPrepareState("idle");
              await copyFeedback.copy(prompt);
              if (prepareAttempt.current !== attempt || activeOrganizationId.current !== organizationId) return;
            } catch {
              if (prepareAttempt.current !== attempt || activeOrganizationId.current !== organizationId) return;
              setPrepareState("failed");
            }
          })();
        }}
      >
        {prepareState === "failed" ? (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        ) : copyFeedback.status === "copied" ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Clipboard className="h-3.5 w-3.5" aria-hidden />
        )}
        {prepareState === "loading" ? "Preparing…" : prepareState === "failed" ? "Retry" : copyLabel}
      </Button>
      <span className="sr-only" aria-live="polite">
        {prepareState === "loading"
          ? "Preparing the setup prompt."
          : prepareState === "failed"
            ? "Setup prompt preparation failed."
            : copyFeedback.status === "copied"
              ? "Setup prompt copied."
              : copyFeedback.status === "failed"
                ? "Setup prompt copy failed."
                : ""}
      </span>
    </div>
  );
}
