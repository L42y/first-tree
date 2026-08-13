import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { FlowHint, StatusRow } from "../../onboarding/flow-ui.js";

/** Read-only first-use observation: Feishu writes; Web waits and hands off. */
export function StepUseInFeishu({
  agentDisplayName,
  chatId,
  readFailed,
  settled,
  failed,
  onRetry,
}: {
  agentDisplayName: string;
  chatId: string | null;
  readFailed: boolean;
  settled: boolean;
  failed: boolean;
  onRetry: () => void;
}): ReactElement {
  if (!chatId) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <StatusRow state="waiting" label="Waiting for the first message…" />
        {readFailed ? (
          <FlowHint tone="error" role="alert">
            We couldn't check for the first task. This page will try again automatically.
          </FlowHint>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StatusRow state="ok" label={`${agentDisplayName} received its first task from Feishu.`} />

      {failed ? (
        <>
          <FlowHint tone="error" role="alert">
            We couldn't finish setting up your workspace. Your agent and its task are unaffected.
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
            <Button type="button" asChild>
              <a href={`/?c=${encodeURIComponent(chatId)}`}>
                View task
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
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
