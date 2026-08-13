import { Check } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../../components/ui/button.js";
import { FlowHint } from "../../onboarding/flow-ui.js";

/**
 * The terminal step: this Agent has a real Feishu Task, so the handoff is over.
 *
 * It is a confirmation, not a decision, so it renders as plain labelled content
 * rather than a panel the member is meant to act inside. The one action leads
 * where the work now lives.
 *
 * The link waits for the completion stamp on purpose. Until that stamp lands
 * the workspace still considers this member's setup unfinished and may send
 * them back into it, so offering the destination early would advertise a door
 * that bounces. Nothing is lost while it waits — the Agent and its task exist
 * either way, which is what the failure copy says.
 */
export function StepUseInFeishu({
  agentDisplayName,
  chatId,
  completing,
  failed,
  onRetry,
}: {
  agentDisplayName: string;
  /** The Feishu Task's chat — the destination this whole entry hands off to. */
  chatId: string;
  /** The completion stamp is in flight. */
  completing: boolean;
  /** The completion stamp failed and the member can try it again. */
  failed: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="flex items-start text-body" style={{ margin: 0, gap: "var(--sp-2)", color: "var(--fg-3)" }}>
        <Check
          aria-hidden="true"
          className="h-4 w-4"
          style={{ flexShrink: 0, marginTop: "var(--sp-0_5)", color: "var(--success)" }}
        />
        <span style={{ minWidth: 0 }}>
          {agentDisplayName} has its first task from Feishu. Message it there as usual — every task it picks up shows up
          here with its full history.
        </span>
      </p>

      {failed ? (
        <>
          <FlowHint tone="error" role="alert">
            We couldn't finish setting up your workspace. Your Agent and its task are unaffected.
          </FlowHint>
          <div className="flex">
            <Button type="button" variant="outline" disabled={completing} onClick={onRetry}>
              {completing ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex">
          {completing ? (
            <Button type="button" variant="cta" disabled>
              Finishing up…
            </Button>
          ) : (
            <Button type="button" variant="cta" asChild>
              <a href={`/?c=${encodeURIComponent(chatId)}`}>Open the task</a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
