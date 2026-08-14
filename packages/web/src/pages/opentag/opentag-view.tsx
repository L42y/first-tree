import { type RuntimeProvider, runtimeProviderLabel } from "@first-tree/shared";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type ReactElement, type ReactNode, type RefObject, useEffect, useRef } from "react";
import type { HubClient } from "../../api/activity.js";
import { Button } from "../../components/ui/button.js";
import { Popover } from "../../components/ui/popover.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";
import type { OpenTagPageState, OpenTagRuntimeState } from "./flow.js";

const FEISHU_BOT_APP_LINK = "https://applink.feishu.cn/client/bot/open";
const FEISHU_MESSENGER_URL = "https://www.feishu.cn/product/messenger";

export type RuntimeChoice = {
  provider: RuntimeProvider;
  ready: boolean;
  status: string;
};

export function OpenTagView({
  pageState,
  connectedClients,
  selectedClientId,
  onSelectClient,
  runtimeState,
  runtimeChoices,
  selectedRuntime,
  onSelectRuntime,
  displayName,
  bootstrapCommand,
  bootstrapError,
  onRetryBootstrap,
  runtimeCommand,
  updateCommand,
  creating,
  createError,
  recoverableAgent,
  onCreate,
  onContinueRecovery,
  signingIn,
  signInError,
  onSignIn,
  onRefreshRuntime,
  feishu,
}: {
  pageState: OpenTagPageState;
  connectedClients: HubClient[];
  selectedClientId: string | null;
  onSelectClient: (clientId: string) => void;
  runtimeState: OpenTagRuntimeState;
  runtimeChoices: RuntimeChoice[];
  selectedRuntime: RuntimeProvider | null;
  onSelectRuntime: (provider: RuntimeProvider) => void;
  displayName: string;
  bootstrapCommand: string | null;
  bootstrapError: string | null;
  onRetryBootstrap: () => void;
  runtimeCommand: string | null;
  updateCommand: string | null;
  creating: boolean;
  createError: string | null;
  recoverableAgent: { displayName: string } | null;
  onCreate: () => void;
  onContinueRecovery: () => void;
  signingIn: boolean;
  signInError: string | null;
  onSignIn: () => void;
  onRefreshRuntime: () => void;
  feishu: {
    appId: string | null;
    registrationUrl: string | null;
    starting: boolean;
    preparingTools: boolean;
    botConnected: boolean;
    error: string | null;
    retryable: boolean;
    retrying: boolean;
    onRetry: () => void;
  };
}): ReactElement {
  const hasComputer = connectedClients.length > 0;
  const hasRuntimePicker = runtimeChoices.filter((choice) => choice.ready).length > 1;
  const runtimeLabel = selectedRuntime ? runtimeProviderLabel(selectedRuntime) : "Agent";

  return (
    <div style={{ marginTop: pageState === "add-to-feishu" ? "calc(var(--opentag-qr-flow-offset) * -1)" : undefined }}>
      <div
        data-opentag-statuses
        data-opentag-runtime-picker={hasRuntimePicker || undefined}
        className="opentag-statuses grid"
        style={{
          gap: "var(--opentag-status-gap)",
          gridTemplateColumns: "var(--opentag-status-columns)",
          marginBottom: pageState === "add-to-feishu" ? "calc(var(--opentag-status-bottom) + var(--sp-5))" : undefined,
        }}
      >
        <ComputerStatus clients={connectedClients} selectedClientId={selectedClientId} onSelect={onSelectClient} />
        <RuntimeStatus
          hasComputer={hasComputer}
          runtimeState={runtimeState}
          choices={runtimeChoices}
          selectedRuntime={selectedRuntime}
          onSelect={onSelectRuntime}
        />
      </div>

      <div className="fade-in" data-opentag-state={pageState}>
        <h2 className="text-headline font-semibold" style={{ margin: 0 }}>
          {headingFor(pageState, displayName)}
        </h2>
        <p className="text-lead" style={{ margin: "var(--sp-2) 0 var(--sp-7)", color: "var(--fg-2)" }}>
          {leadFor(pageState, displayName, runtimeLabel, runtimeState)}
        </p>

        <ActionSurface qr={pageState === "add-to-feishu" && !!feishu.registrationUrl}>
          {pageState === "connect-computer" &&
            (bootstrapError ? (
              <InlineRecovery message={bootstrapError} retrying={false} onRetry={onRetryBootstrap} />
            ) : (
              <CommandAction
                command={bootstrapCommand}
                fallback="Preparing your secure connection command…"
                buttonLabel="Copy command"
              />
            ))}

          {pageState === "agent-blocked" && (
            <RuntimeRecovery
              runtimeState={runtimeState}
              command={updateCommand ?? runtimeCommand}
              updateRequired={!!updateCommand}
              signingIn={signingIn}
              signInError={signInError}
              onSignIn={onSignIn}
              onRefresh={onRefreshRuntime}
            />
          )}

          {pageState === "create-agent" &&
            (recoverableAgent ? (
              <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
                <p className="text-lead" role="alert" style={{ margin: 0 }}>
                  An agent named {recoverableAgent.displayName} already exists.
                </p>
                <PrimaryAction onClick={onContinueRecovery}>Use existing agent</PrimaryAction>
              </div>
            ) : (
              <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
                <p className="text-lead font-semibold" style={{ margin: 0 }}>
                  Everything is ready.
                </p>
                <PrimaryAction disabled={creating || displayName.trim().length === 0} onClick={onCreate}>
                  {creating ? "Creating…" : "Create agent"}
                </PrimaryAction>
              </div>
            ))}

          {pageState === "add-to-feishu" && <FeishuAction {...feishu} displayName={displayName} />}

          {pageState === "ready" && (
            <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
              <div className="flex items-center" style={{ gap: "var(--sp-4)" }}>
                <img src="/feishu-mark.svg" alt="" aria-hidden="true" className="h-10 w-10 shrink-0" />
                <p className="text-lead" style={{ margin: 0 }}>
                  {displayName} is connected to Feishu.
                </p>
              </div>
              <PrimaryAction asLink href={feishuDestination(feishu.appId)}>
                Open Feishu
              </PrimaryAction>
            </div>
          )}
        </ActionSurface>

        {pageState === "connect-computer" && (
          <StatusCopy>Waiting for your Computer. We’ll continue automatically.</StatusCopy>
        )}
        {pageState === "agent-blocked" && (
          <StatusCopy>We’ll continue automatically when {runtimeLabel} is ready.</StatusCopy>
        )}
        {pageState === "add-to-feishu" && (
          <StatusCopy>
            {feishu.registrationUrl
              ? `Preparing ${displayName} in the background. You can scan now.`
              : feishu.botConnected
                ? `Finishing ${displayName} in the background.`
                : "Preparing a secure Feishu registration…"}
          </StatusCopy>
        )}
      </div>

      {createError && !recoverableAgent && (
        <div role="alert" className="text-body" style={{ marginTop: "var(--sp-4)", color: "var(--state-error)" }}>
          {createError}
        </div>
      )}
    </div>
  );
}

function ComputerStatus({
  clients,
  selectedClientId,
  onSelect,
}: {
  clients: HubClient[];
  selectedClientId: string | null;
  onSelect: (clientId: string) => void;
}): ReactElement {
  const connected = clients.length > 0;
  const label = connected ? "Connected" : "Not connected";
  return (
    <StatusLine ready={connected} label={`Computer · ${label}`}>
      {clients.length > 1 ? (
        <ChoicePopover label="Change Computer" compactOnNarrow>
          {(close) => (
            <ChoiceList>
              {clients.map((client) => (
                <ChoiceRow
                  key={client.id}
                  selected={client.id === selectedClientId}
                  label={client.hostname ?? "Computer"}
                  status="Connected"
                  onClick={() => {
                    onSelect(client.id);
                    close();
                  }}
                />
              ))}
            </ChoiceList>
          )}
        </ChoicePopover>
      ) : null}
    </StatusLine>
  );
}

function RuntimeStatus({
  hasComputer,
  runtimeState,
  choices,
  selectedRuntime,
  onSelect,
}: {
  hasComputer: boolean;
  runtimeState: OpenTagRuntimeState;
  choices: RuntimeChoice[];
  selectedRuntime: RuntimeProvider | null;
  onSelect: (provider: RuntimeProvider) => void;
}): ReactElement {
  const ready = runtimeState.kind === "ready";
  const label = !hasComputer
    ? "Agent · Waiting for Computer"
    : runtimeState.kind === "checking"
      ? "Agent · Checking"
      : runtimeState.kind === "ready"
        ? `Agent · ${runtimeProviderLabel(runtimeState.provider)} ready`
        : runtimeState.kind === "signing-in"
          ? `Agent · Finish ${runtimeProviderLabel(runtimeState.provider)} sign-in`
          : runtimeState.kind === "sign-in"
            ? `Agent · ${runtimeProviderLabel(runtimeState.provider)} sign-in required`
            : runtimeState.kind === "install"
              ? `Agent · Install ${runtimeProviderLabel(runtimeState.provider)}`
              : "Agent · Check failed";
  const multipleReady = choices.filter((choice) => choice.ready).length > 1;

  return (
    <StatusLine ready={ready} label={label}>
      {multipleReady ? (
        <ChoicePopover label="Change Agent">
          {(close) => (
            <ChoiceList>
              {choices.map((choice) => {
                return (
                  <ChoiceRow
                    key={choice.provider}
                    selected={choice.provider === selectedRuntime}
                    label={runtimeProviderLabel(choice.provider)}
                    status={choice.status}
                    ready={choice.ready}
                    onClick={() => {
                      onSelect(choice.provider);
                      close();
                    }}
                  />
                );
              })}
            </ChoiceList>
          )}
        </ChoicePopover>
      ) : null}
    </StatusLine>
  );
}

function StatusLine({
  ready,
  label,
  children,
}: {
  ready: boolean;
  label: string;
  children?: ReactElement | null;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center" style={{ gap: "var(--opentag-status-item-gap)" }}>
      <span
        aria-hidden="true"
        className="h-5 w-5 shrink-0 rounded-[var(--radius-full)]"
        style={{ background: ready ? "var(--opentag-accent)" : "var(--state-offline)" }}
      />
      <span className="min-w-0 truncate text-lead">{label}</span>
      {children}
    </div>
  );
}

function ChoicePopover({
  label,
  children,
  compactOnNarrow = false,
}: {
  label: string;
  children: (close: () => void) => ReactElement;
  compactOnNarrow?: boolean;
}): ReactElement {
  const anchorRef = useRef<HTMLSpanElement>(null);

  return (
    <span ref={anchorRef} className="contents">
      <Popover
        align="end"
        panelAriaLabel={label}
        panelClassName="opentag-choice-panel surface-overlay w-[var(--sp-90)] p-3"
        trigger={({ toggle, open }) => (
          <Button
            type="button"
            variant="link"
            className={`h-auto shrink-0 p-0 text-body font-normal${compactOnNarrow ? " opentag-choice-trigger--compact" : ""}`}
            aria-label={compactOnNarrow ? label : undefined}
            aria-expanded={open}
            onClick={toggle}
          >
            <span className="opentag-choice-label">Change</span> <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        )}
      >
        {({ close }) => (
          <>
            <OpenTagPickerPlacement anchorRef={anchorRef} />
            {children(close)}
          </>
        )}
      </Popover>
    </span>
  );
}

type PickerPlacement = {
  triggerTop: number;
  panelHeight: number;
  viewportTop: number;
  viewportHeight: number;
  margin: number;
  gap: number;
};

export function openTagPickerTop({
  triggerTop,
  panelHeight,
  viewportTop,
  viewportHeight,
  margin,
  gap,
}: PickerPlacement): number {
  const minimum = viewportTop + margin;
  const maximum = Math.max(minimum, viewportTop + viewportHeight - margin - panelHeight);
  const above = triggerTop - gap - panelHeight;
  return Math.max(minimum, Math.min(above, maximum));
}

function OpenTagPickerPlacement({ anchorRef }: { anchorRef: RefObject<HTMLSpanElement | null> }): ReactElement {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      const marker = markerRef.current;
      const panel = marker?.parentElement;
      const trigger = anchorRef.current?.querySelector("button");
      if (!marker || !panel || !trigger) return;

      const markerStyles = window.getComputedStyle(marker);
      const margin = Number.parseFloat(markerStyles.scrollMarginBottom);
      const gap = Number.parseFloat(markerStyles.scrollMarginTop);
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const triggerRect = trigger.getBoundingClientRect();
      const top = openTagPickerTop({
        triggerTop: triggerRect.top,
        panelHeight: panel.offsetHeight,
        viewportTop,
        viewportHeight,
        margin,
        gap,
      });
      const baseTop = Number.parseFloat(panel.style.top);
      panel.style.setProperty("--opentag-picker-shift", String(top - baseTop));
    };
    const schedule = (): void => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(place);
      });
    };

    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [anchorRef]);

  return <span ref={markerRef} className="opentag-picker-placement" aria-hidden="true" />;
}

function ChoiceList({ children }: { children: ReactElement | Array<ReactElement | null> }): ReactElement {
  return (
    <div className="opentag-choice-list flex flex-col" style={{ gap: "var(--sp-1)" }}>
      {children}
    </div>
  );
}

function ChoiceRow({
  selected,
  label,
  status,
  ready = true,
  onClick,
}: {
  selected: boolean;
  label: string;
  status: string;
  ready?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="flex w-full items-center rounded-[var(--radius-input)] px-3 py-3 text-left text-body focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ background: selected ? "var(--state-working-soft)" : "transparent" }}
      onClick={onClick}
    >
      <span className="w-7 shrink-0" style={{ color: "var(--success)" }}>
        {selected ? <Check className="h-4 w-4" /> : null}
      </span>
      <span className="flex-1 font-medium">{label}</span>
      <span style={{ color: ready ? "var(--success)" : "var(--fg-3)" }}>{status}</span>
    </button>
  );
}

function ActionSurface({ children, qr = false }: { children: ReactNode; qr?: boolean }): ReactElement {
  return (
    <div
      data-opentag-action
      className="flex w-full items-center text-opentag-action"
      style={{
        minHeight: qr ? "var(--opentag-action-qr-height)" : "var(--opentag-action-height)",
        padding: "var(--opentag-action-padding)",
        borderRadius: "var(--radius-opentag-action)",
        background: "var(--opentag-action)",
        color: "var(--opentag-action-fg)",
      }}
    >
      {children}
    </div>
  );
}

function CommandAction({
  command,
  fallback,
  buttonLabel,
}: {
  command: string | null;
  fallback: string;
  buttonLabel: string;
}): ReactElement {
  const copyFeedback = useCopyFeedback();
  const priorCommand = useRef(command);
  useEffect(() => {
    if (priorCommand.current === command) return;
    priorCommand.current = command;
    copyFeedback.reset();
  }, [command, copyFeedback.reset]);
  const feedbackLabel =
    copyFeedback.status === "copied" ? "Copied" : copyFeedback.status === "failed" ? "Copy failed" : buttonLabel;
  return (
    <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
      <pre className="min-w-0 flex-1 whitespace-pre-wrap text-body font-mono" style={{ margin: 0 }}>
        {command ?? fallback}
      </pre>
      <PrimaryAction disabled={!command} onClick={() => command && void copyFeedback.copy(command)}>
        {feedbackLabel}
      </PrimaryAction>
    </div>
  );
}

function InlineRecovery({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
      <p className="text-lead" role="alert" style={{ margin: 0 }}>
        {message}
      </p>
      <PrimaryAction disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Try again"}
      </PrimaryAction>
    </div>
  );
}

function RuntimeRecovery({
  runtimeState,
  command,
  updateRequired,
  signingIn,
  signInError,
  onSignIn,
  onRefresh,
}: {
  runtimeState: OpenTagRuntimeState;
  command: string | null;
  updateRequired: boolean;
  signingIn: boolean;
  signInError: string | null;
  onSignIn: () => void;
  onRefresh: () => void;
}): ReactElement {
  if (updateRequired) {
    return <CommandAction command={command} fallback="Preparing update command…" buttonLabel="Copy update command" />;
  }
  if (runtimeState.kind === "checking") {
    return (
      <div className="flex items-center" style={{ gap: "var(--sp-3)" }} role="status">
        <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span className="text-lead">Checking local Agents…</span>
      </div>
    );
  }
  if (runtimeState.kind === "signing-in") {
    return (
      <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
        <p className="text-lead" style={{ margin: 0 }}>
          Finish signing in on this Computer.
        </p>
        {safeHttpUrl(runtimeState.authUrl) ? (
          <PrimaryAction asLink href={runtimeState.authUrl}>
            Open sign-in
          </PrimaryAction>
        ) : null}
      </div>
    );
  }
  if (runtimeState.kind === "sign-in") {
    const label = runtimeProviderLabel(runtimeState.provider);
    return (
      <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
        <div>
          <p className="text-lead" style={{ margin: 0 }}>
            {label} needs permission to run tasks.
          </p>
          {signInError ? (
            <p className="text-body" role="alert" style={{ margin: "var(--sp-2) 0 0", color: "var(--state-error)" }}>
              {signInError}
            </p>
          ) : null}
        </div>
        <PrimaryAction disabled={signingIn} onClick={onSignIn}>
          {signingIn ? "Opening…" : `Sign in to ${label}`}
        </PrimaryAction>
      </div>
    );
  }
  if (runtimeState.kind === "install") {
    return <CommandAction command={command} fallback="Preparing install command…" buttonLabel="Copy install command" />;
  }
  return (
    <div className="flex w-full items-center justify-between" style={{ gap: "var(--sp-8)" }}>
      <p className="text-lead" style={{ margin: 0 }}>
        We couldn’t verify this local Agent.
      </p>
      <PrimaryAction onClick={onRefresh}>Check again</PrimaryAction>
    </div>
  );
}

function FeishuAction({
  displayName,
  registrationUrl,
  starting,
  preparingTools,
  botConnected,
  error,
  retryable,
  retrying,
  onRetry,
}: {
  displayName: string;
  registrationUrl: string | null;
  starting: boolean;
  preparingTools: boolean;
  botConnected: boolean;
  error: string | null;
  retryable: boolean;
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  if (error) {
    return retryable ? (
      <InlineRecovery message={error} retrying={retrying} onRetry={onRetry} />
    ) : (
      <p className="text-lead" role="alert" style={{ margin: 0 }}>
        {error}
      </p>
    );
  }
  if (registrationUrl) {
    return (
      <div
        className="grid w-full items-center"
        style={{
          gridTemplateColumns: "calc(var(--opentag-qr-size) + var(--sp-6)) minmax(0, 1fr)",
          gap: "var(--sp-10)",
        }}
      >
        <span data-opentag-qr className="rounded-[var(--radius-input)] bg-[var(--qr-bg)] p-3">
          <QRCodeSVG
            value={registrationUrl}
            marginSize={1}
            title="Feishu bot registration QR code"
            style={{ width: "var(--opentag-qr-size)", height: "var(--opentag-qr-size)" }}
          />
        </span>
        <div className="flex items-center" style={{ gap: "var(--sp-4)" }}>
          <img src="/feishu-mark.svg" alt="" aria-hidden="true" className="h-16 w-16 shrink-0" />
          <div>
            <p className="text-headline font-semibold" style={{ margin: 0 }}>
              Scan with Feishu
            </p>
            <p className="text-lead" style={{ margin: "var(--sp-3) 0 0", color: "var(--opentag-action-muted)" }}>
              Open Feishu and scan this code to add {displayName}.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-3)" }} role="status">
      <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="text-lead">
        {starting
          ? "Preparing Feishu registration…"
          : botConnected && preparingTools
            ? "Preparing Feishu tools…"
            : "Finishing Feishu setup…"}
      </span>
    </div>
  );
}

function PrimaryAction({
  children,
  disabled,
  onClick,
  asLink = false,
  href,
}: {
  children: string;
  disabled?: boolean;
  onClick?: () => void;
  asLink?: boolean;
  href?: string;
}): ReactElement {
  const className =
    "opentag-primary-action h-[var(--opentag-cta-height)] rounded-[var(--radius-opentag-cta)] px-7 text-lead font-semibold";
  if (asLink && href) {
    return (
      <Button variant="cta" className={className} asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button type="button" variant="cta" className={className} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

function StatusCopy({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="text-lead" role="status" style={{ margin: "var(--sp-7) 0 0", color: "var(--fg-2)" }}>
      {children}
    </p>
  );
}

function headingFor(state: OpenTagPageState, displayName: string): string {
  switch (state) {
    case "connect-computer":
      return "Connect your Computer";
    case "agent-blocked":
      return "Get your Agent ready";
    case "create-agent":
      return "Create agent";
    case "add-to-feishu":
      return `Add ${displayName} to Feishu`;
    case "ready":
      return `${displayName} is ready`;
  }
}

function leadFor(
  state: OpenTagPageState,
  displayName: string,
  runtimeLabel: string,
  runtimeState: OpenTagRuntimeState,
): string {
  switch (state) {
    case "connect-computer":
      return "Run this command in Terminal.";
    case "agent-blocked":
      if (runtimeState.kind === "sign-in" || runtimeState.kind === "signing-in") {
        return `Sign in to ${runtimeLabel} on this Computer.`;
      }
      if (runtimeState.kind === "install") return `Install ${runtimeLabel} on this Computer.`;
      if (runtimeState.kind === "checking") return "Checking local Agents on this Computer.";
      return `Check ${runtimeLabel} on this Computer.`;
    case "create-agent":
      return `Create ${displayName} with this Computer and ${runtimeLabel}.`;
    case "add-to-feishu":
      return "Scan this code with Feishu. Setup continues in the background.";
    case "ready":
      return "Open Feishu and start with a real task.";
  }
}

function safeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function feishuDestination(appId: string | null): string {
  if (!appId) return FEISHU_MESSENGER_URL;
  const destination = new URL(FEISHU_BOT_APP_LINK);
  destination.searchParams.set("appId", appId);
  return destination.toString();
}
