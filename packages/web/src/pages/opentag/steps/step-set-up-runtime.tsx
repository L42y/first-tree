import { orderRuntimeProvidersByPreference, type RuntimeProvider, runtimeProviderLabel } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { ConnectedComputerSelect, ConnectedComputerSummary } from "../../../components/connected-computer-select.js";
import { Button } from "../../../components/ui/button.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import type { ComputerConnection } from "../../../features/agent-setup/use-computer-connection.js";
import { CommandBox, FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/** Select a real computer and executable coding agent, then materialize atomically. */
export function StepSetUpRuntime({
  computer,
  draft,
  onUseComputer,
  onBack,
  pending,
  error,
  recovery,
}: {
  computer: ComputerConnection;
  draft: { displayName: string; templateName: string };
  onUseComputer: (clientId: string, runtimeProvider: RuntimeProvider) => void;
  onBack: () => void;
  pending: boolean;
  error: string | null;
  recovery: { displayName: string; pending: boolean; onContinue: () => void } | null;
}): ReactElement {
  const {
    connectedClients,
    selectedClientId,
    setSelectedClientId,
    cliCommand,
    tokenError,
    retry,
    selectedRuntime,
    setSelectedRuntime,
  } = computer;
  const single = connectedClients.length === 1 ? connectedClients[0] : null;
  const orderedRuntimes = orderRuntimeProvidersByPreference(computer.okRuntimes);
  const runtimeReady = !!selectedRuntime && computer.okRuntimes.includes(selectedRuntime);
  const noRuntime = computer.capabilitiesLoaded && orderedRuntimes.length === 0;

  if (connectedClients.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
        <section className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <h2 className="text-label font-semibold" style={{ margin: 0, color: "var(--fg-2)" }}>
            Connect your computer
          </h2>
          <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
            Connect the computer where you want this agent to work.
          </p>
          {tokenError ? (
            <FlowHint tone="error" role="alert">
              We couldn't prepare the setup command.
            </FlowHint>
          ) : (
            <>
              <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
                Open Terminal on that computer and run:
              </p>
              <CommandBox command={cliCommand} />
            </>
          )}
        </section>
        {tokenError ? (
          <div className="flex">
            <Button type="button" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <StatusRow state="waiting" label="Waiting for your computer to connect…" />
        )}
        <LabeledDetail label="Draft agent">
          {draft.displayName} · {draft.templateName}
        </LabeledDetail>
        <BackLink onBack={onBack} disabled={false} />
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          {single ? "Computer" : "Choose a computer"}
        </legend>
        {single ? (
          <ConnectedComputerSummary client={single} />
        ) : (
          <ConnectedComputerSelect
            clients={connectedClients}
            value={selectedClientId}
            onChange={setSelectedClientId}
            id="opentag-runtime-computer"
          />
        )}
      </fieldset>

      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          Coding agent
        </legend>
        {!selectedClientId ? null : !computer.capabilitiesLoaded ? (
          <p className="text-body" role="status" style={{ margin: 0, color: "var(--fg-3)" }}>
            Checking available coding agents…
          </p>
        ) : noRuntime ? (
          <FlowHint role="status">
            No supported coding agent was found on this computer. Install one, then we'll check again.
          </FlowHint>
        ) : (
          <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
            {orderedRuntimes.map((provider) => (
              <OptionCard
                key={provider}
                name="opentag-coding-agent"
                layout="pill"
                checked={selectedRuntime === provider}
                onSelect={() => setSelectedRuntime(provider)}
              >
                <span className="text-body">{runtimeProviderLabel(provider)}</span>
              </OptionCard>
            ))}
          </div>
        )}
      </fieldset>

      <LabeledDetail label="Draft agent">
        {draft.displayName} · {draft.templateName}
      </LabeledDetail>

      {error ? (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      ) : null}

      {recovery ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <p className="text-label" style={{ margin: 0, color: "var(--fg-2)" }}>
            You already have an agent called {recovery.displayName}. If your last attempt looked like it failed, this is
            probably it.
          </p>
          <div className="flex">
            <Button type="button" variant="outline" disabled={recovery.pending} onClick={recovery.onContinue}>
              {recovery.pending ? "Continuing…" : `Continue with ${recovery.displayName}`}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-3)" }}>
        <Button
          type="button"
          variant="cta"
          disabled={!selectedClientId || !runtimeReady || pending}
          onClick={() => {
            if (!selectedClientId || !selectedRuntime || !runtimeReady || pending) return;
            onUseComputer(selectedClientId, selectedRuntime);
          }}
        >
          <span>{pending ? "Creating your agent…" : "Create agent"}</span>
          {!pending ? <ArrowRight className="h-4 w-4" /> : null}
        </Button>
        <BackLink onBack={onBack} disabled={pending} />
      </div>
    </div>
  );
}

function BackLink({ onBack, disabled }: { onBack: () => void; disabled: boolean }): ReactElement {
  return (
    <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onBack} disabled={disabled}>
      Back to focus & name
    </Button>
  );
}

function LabeledDetail({ label, children }: { label: string; children: ReactNode }): ReactElement {
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
