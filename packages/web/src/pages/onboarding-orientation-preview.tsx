import { type ReactNode, useState } from "react";
import {
  ONBOARDING_ORIENTATION_CONTINUE_MESSAGE,
  OnboardingOrientation,
} from "../components/chat/onboarding-orientation.js";
import { Button } from "../components/ui/button.js";

/** DEV-only visual review surface for the real inline first-chat Orientation. */

type Variant = "current" | "proposed";

function MessageRow({ name, initial, children }: { name: string; initial: string; children: ReactNode }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", gap: "var(--sp-2)" }}>
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-full bg-secondary text-caption font-semibold"
      >
        {initial}
      </span>
      <div className="min-w-0">
        <p className="mono text-body font-semibold">{name}</p>
        <div className="text-body mt-1">{children}</div>
      </div>
    </div>
  );
}

function ContinuationRows() {
  return (
    <>
      <MessageRow name="Gandy" initial="G">
        <p>{ONBOARDING_ORIENTATION_CONTINUE_MESSAGE}</p>
      </MessageRow>
      <MessageRow name="Nova" initial="N">
        <p className="text-muted-foreground">
          The existing first-task guidance begins here after the visible continue message wakes the agent.
        </p>
      </MessageRow>
    </>
  );
}

/** Today's rendering: the bootstrap is an ordinary user-attributed message with the card below its body. */
function CurrentVariant({ completed, onContinue }: { completed: boolean; onContinue: () => void }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <MessageRow name="Gandy" initial="G">
        <p>
          Nova, welcome aboard.
          <br />
          <br />
          Please help me get started with First Tree.
        </p>
        <OnboardingOrientation
          key={completed ? "completed" : "pending"}
          completed={completed}
          continuing={false}
          targetAgentName="Nova"
          onContinue={onContinue}
        />
      </MessageRow>
      {completed ? <ContinuationRows /> : null}
    </div>
  );
}

/**
 * Proposed rendering: the bootstrap body and sender attribution are not shown.
 * The Orientation is a sender-less full-width card; the member's continuation
 * is the first attributed message in the timeline.
 */
function ProposedVariant({ completed, onContinue }: { completed: boolean; onContinue: () => void }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <div className="[&>section]:mt-0">
        <OnboardingOrientation
          key={completed ? "completed" : "pending"}
          completed={completed}
          continuing={false}
          targetAgentName="Nova"
          onContinue={onContinue}
        />
      </div>
      {completed ? <ContinuationRows /> : null}
    </div>
  );
}

export function OnboardingOrientationPreviewPage() {
  const [variant, setVariant] = useState<Variant>("proposed");
  const [completed, setCompleted] = useState(false);

  return (
    <main className="min-h-screen bg-background p-4 sm:p-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-wrap items-end justify-between" style={{ gap: "var(--sp-3)" }}>
          <div>
            <p className="mono text-caption text-muted-foreground">DEV PREVIEW · REAL COMPONENT</p>
            <h1 className="text-title font-semibold">First-chat Orientation</h1>
            <p className="text-body text-muted-foreground">
              Resize to a narrow phone width to review the mobile layout.
            </p>
          </div>
          <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
            <div className="flex" style={{ gap: "var(--sp-2)" }}>
              <Button
                type="button"
                variant={variant === "current" ? "default" : "outline"}
                onClick={() => setVariant("current")}
              >
                Current
              </Button>
              <Button
                type="button"
                variant={variant === "proposed" ? "default" : "outline"}
                onClick={() => setVariant("proposed")}
              >
                Proposed
              </Button>
            </div>
            <div className="flex" style={{ gap: "var(--sp-2)" }}>
              <Button type="button" variant={!completed ? "default" : "outline"} onClick={() => setCompleted(false)}>
                Pending
              </Button>
              <Button type="button" variant={completed ? "default" : "outline"} onClick={() => setCompleted(true)}>
                Completed
              </Button>
            </div>
          </div>
        </header>

        <section aria-label="First chat message preview" className="border-y border-border py-4">
          {variant === "current" ? (
            <CurrentVariant completed={completed} onContinue={() => setCompleted(true)} />
          ) : (
            <ProposedVariant completed={completed} onContinue={() => setCompleted(true)} />
          )}
        </section>
      </div>
    </main>
  );
}
