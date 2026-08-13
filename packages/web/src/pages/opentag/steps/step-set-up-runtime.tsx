import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";
import { ConnectedComputerSelect, ConnectedComputerSummary } from "../../../components/connected-computer-select.js";
import { Button } from "../../../components/ui/button.js";
import type { ComputerConnection } from "../../../features/agent-setup/use-computer-connection.js";
import { CommandBox, FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/**
 * Give the Agent one Computer.
 *
 * Three shapes, one decision each:
 *   - no Computer — the server-authored connect command inline, then the same
 *     poll every connect surface uses;
 *   - one Computer — recommended directly, nothing to pick;
 *   - several — an explicit choice, because silently taking the most recent
 *     heartbeat would pin the Agent to a machine the member never named.
 *
 * The bind is the one-shot claim of an unbound Agent, so a failure has to stay
 * on this step: advancing on anything but an authoritative bind would show the
 * member a Feishu step for an Agent that still has nowhere to run.
 */
export function StepSetUpRuntime({
  computer,
  onUseComputer,
  pending,
  error,
}: {
  computer: ComputerConnection;
  onUseComputer: (clientId: string) => void;
  pending: boolean;
  error: string | null;
}): ReactElement {
  const { connectedClients, selectedClientId, setSelectedClientId, cliCommand, tokenError, retry } = computer;
  const single = connectedClients.length === 1 ? connectedClients[0] : null;

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
        <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
          This Agent stays on the computer you choose. Your other computers are not affected.
        </p>
      </div>

      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}

      <div className="flex">
        <Button
          type="button"
          variant="cta"
          disabled={!selectedClientId || pending}
          onClick={() => {
            if (!selectedClientId || pending) return;
            onUseComputer(selectedClientId);
          }}
        >
          <span>{pending ? "Setting up…" : single ? "Use this computer" : "Use selected computer"}</span>
          {!pending && <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
