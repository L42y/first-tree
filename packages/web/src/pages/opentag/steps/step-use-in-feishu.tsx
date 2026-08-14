import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/** The ready handoff: setup is complete before the member sends any work. */
export function StepUseInFeishu({
  agentDisplayName,
  settled,
  failed,
  onRetry,
}: {
  agentDisplayName: string;
  settled: boolean;
  failed: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StatusRow state="ok" label={`${agentDisplayName} is ready in Feishu.`} />

      {failed ? (
        <>
          <FlowHint tone="error" role="alert">
            We couldn't finish setting up your workspace. Your agent and its Feishu connection are unaffected.
          </FlowHint>
          <div className="flex">
            <Button type="button" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </>
      ) : (
        <div className="flex">
          {settled ? (
            <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
              Open Feishu to start working with your agent.
            </p>
          ) : (
            <Button type="button" disabled>
              Finishing up…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
