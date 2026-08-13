import { type RuntimeProvider, runtimeProviderLabel } from "@first-tree/shared";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ReactElement } from "react";
import { ConnectedComputerSelect, ConnectedComputerSummary } from "../../../components/connected-computer-select.js";
import { Button } from "../../../components/ui/button.js";
import type { ComputerConnection } from "../../../features/agent-setup/use-computer-connection.js";
import { CommandBox, FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/**
 * Choose the Computer the Agent will run on — and create it.
 *
 * Three shapes, one decision each:
 *   - no Computer — the server-authored connect command inline, then the same
 *     poll every connect surface uses;
 *   - one Computer — recommended directly, nothing to pick;
 *   - several — an explicit choice, because silently taking the most recent
 *     heartbeat would pin the Agent to a machine the member never named.
 *
 * This is where the Agent is finally materialized: the Template chosen on the
 * previous screen plus this Computer and its ready runtime go into one atomic
 * create, so there is never an Agent with nowhere to run. A failure therefore
 * has to stay here — nothing was created, and the member can retry or pick a
 * different Computer.
 */
export function StepSetUpRuntime({
  computer,
  onUseComputer,
  onBack,
  pending,
  error,
  recovery,
}: {
  computer: ComputerConnection;
  onUseComputer: (clientId: string, runtimeProvider: RuntimeProvider) => void;
  onBack: () => void;
  pending: boolean;
  error: string | null;
  /** Offered when a repeated create collided with an Agent this member already owns. */
  recovery: { displayName: string; pending: boolean; onContinue: () => void } | null;
}): ReactElement {
  const { connectedClients, selectedClientId, setSelectedClientId, cliCommand, tokenError, retry } = computer;
  const single = connectedClients.length === 1 ? connectedClients[0] : null;
  // The runtime comes from this Computer's own capabilities, chosen by the
  // shared catalog preference rather than by a picker — the Computer stays the
  // single decision. Nothing ready to run on means nothing to create.
  const runtime = computer.selectedRuntime;
  const runtimeReady = !!runtime && computer.okRuntimes.includes(runtime);
  const noRuntime = computer.capabilitiesLoaded && computer.okRuntimes.length === 0;

  if (connectedClients.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {tokenError ? (
          <>
            <FlowHint tone="error" role="alert">
              We couldn't prepare the connect command.
            </FlowHint>
            <div className="flex">
              <Button type="button" onClick={retry}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
                Run this in a terminal on the computer you want to use
              </p>
              <CommandBox command={cliCommand} />
            </div>
            <StatusRow state="waiting" label="Waiting for your computer to connect…" />
          </>
        )}
        {/* Waiting for a Computer is the most common first-run state and the
            longest one, so the way back to the teammate choice has to be here
            too — not only once a Computer has shown up. */}
        <BackLink onBack={onBack} disabled={false} />
      </div>
    );
  }

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
        <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
          {single ? "Your connected computer" : "Choose a computer"}
        </p>
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
        {noRuntime ? (
          <FlowHint role="status">
            No coding agent is installed on this computer yet. Install one, then this step picks it up.
          </FlowHint>
        ) : runtimeReady && runtime ? (
          <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
            It will run with {runtimeProviderLabel(runtime)}. Your Agent is created on the computer you choose, and your
            other computers are not affected.
          </p>
        ) : (
          <p className="text-caption" role="status" style={{ margin: 0, color: "var(--fg-3)" }}>
            Checking what this computer can run…
          </p>
        )}
      </div>

      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}

      {recovery && (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <p className="text-label" style={{ margin: 0, color: "var(--fg-2)" }}>
            You already have an Agent called {recovery.displayName}. If your last attempt looked like it failed, this is
            probably it.
          </p>
          <div className="flex">
            <Button type="button" variant="outline" disabled={recovery.pending} onClick={recovery.onContinue}>
              {recovery.pending ? "Continuing…" : `Continue with ${recovery.displayName}`}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <Button
          type="button"
          variant="cta"
          disabled={!selectedClientId || !runtimeReady || pending}
          onClick={() => {
            if (!selectedClientId || !runtime || !runtimeReady || pending) return;
            onUseComputer(selectedClientId, runtime);
          }}
        >
          <span>{pending ? "Creating your Agent…" : "Create Agent"}</span>
          {!pending && <ArrowRight className="h-4 w-4" />}
        </Button>
        <BackLink onBack={onBack} disabled={pending} />
      </div>
    </div>
  );
}

/** The way back to the teammate choice. Nothing has been created yet. */
function BackLink({ onBack, disabled }: { onBack: () => void; disabled: boolean }): ReactElement {
  return (
    <div className="flex">
      <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onBack} disabled={disabled}>
        <ArrowLeft className="h-3.5 w-3.5" />
        Choose a different teammate
      </Button>
    </div>
  );
}
