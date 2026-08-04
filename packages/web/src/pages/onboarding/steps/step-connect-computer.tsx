import { orderRuntimeProvidersBySelection, runtimeProviderLabel } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowHint, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Install the First Tree client (a small background app) on the user's computer.
 * The user runs the server-authored command in a terminal. We poll until the
 * computer shows up, then list what First Tree agents can run on it (read-only
 * — choosing one moves to the next step, create-agent).
 *
 * No "Need help?" disclosure / example terminal: the normal state is just the
 * server-provided command(s) + status.
 */
export function StepConnectComputer() {
  const { computer, goNext } = useOnboardingFlow();
  const { connectedClient, capabilitiesLoaded, okRuntimes, cliCommand, tokenError, retry } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;
  const orderedRuntimes = orderRuntimeProvidersBySelection(okRuntimes);
  const stepBody = connectedClient ? COPY.connectComputer.whyConnected : COPY.connectComputer.whyWaiting;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      {stepBody ? (
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {stepBody}
        </p>
      ) : null}

      {!connectedClient ? (
        tokenError ? (
          // Just the message — the retry action rides on the step's primary
          // bottom button (which becomes "Try again" in this state), so there's
          // no separate retry button + a dead disabled "Continue".
          <FlowHint tone="error" role="alert">
            {COPY.connectComputer.tokenErrorTitle}
          </FlowHint>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
                {COPY.connectComputer.terminalBoxLabel}
              </p>
              <CommandBox command={cliCommand} />
            </div>
            <StatusRow state="waiting" label={COPY.connectComputer.waiting} />
          </div>
        )
      ) : (
        <>
          <StatusRow
            state="ok"
            label={
              <>
                <span className="mono font-semibold">{connectedClient.hostname ?? connectedClient.id}</span>{" "}
                {COPY.connectComputer.connected}
              </>
            }
          />
          {!capabilitiesLoaded ? (
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {COPY.connectComputer.detecting}
            </p>
          ) : noRuntime ? (
            <FlowHint>{COPY.connectComputer.noRuntime}</FlowHint>
          ) : (
            // Detected coding agents — a READ-ONLY list (name + status). Choosing
            // which one to use is the next step (create-agent), not here. The
            // list is nested UNDER the connected-computer row (indented behind a
            // containment rail, with quieter dot markers) so it reads as "found
            // ON this machine" rather than as peers of the computer above — the
            // bold green check stays the computer's alone.
            <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
              <div
                className="flex flex-col"
                style={{
                  gap: "var(--sp-2)",
                  // Align the rail under the computer row's check glyph so the
                  // indent reads as containment, not an arbitrary offset.
                  marginLeft: "var(--sp-1_5)",
                  paddingLeft: "var(--sp-3)",
                  borderLeft: "var(--hairline) solid var(--border)",
                }}
              >
                {/* Names the nested group so the relationship is stated, not
                    only implied by the indent. */}
                <p className="text-caption" style={{ margin: 0, color: "var(--fg-4)" }}>
                  {COPY.connectComputer.detectedLabel}
                </p>
                <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
                  {orderedRuntimes.map((r) => (
                    <div
                      key={r}
                      className="inline-flex items-center text-label"
                      role="status"
                      style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: "var(--sp-1_5)",
                          height: "var(--sp-1_5)",
                          flexShrink: 0,
                          borderRadius: "var(--radius-full)",
                          background: "var(--success)",
                        }}
                      />
                      <span className="font-medium" style={{ color: "var(--fg)" }}>
                        {runtimeProviderLabel(r)}
                      </span>
                      <span style={{ color: "var(--success)" }}>· ready</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
                {COPY.connectComputer.detectedBridge}
              </p>
            </div>
          )}
        </>
      )}

      <div className="flex">
        {tokenError && !connectedClient ? (
          // Token mint failed: the only useful action is retry, so the primary
          // button itself becomes "Try again" rather than sitting disabled
          // beside a separate retry button.
          <Button type="button" onClick={retry}>
            <span>{COPY.connectComputer.retry}</span>
          </Button>
        ) : (
          <Button type="button" onClick={goNext} disabled={!ready}>
            <span>{COPY.continue}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
