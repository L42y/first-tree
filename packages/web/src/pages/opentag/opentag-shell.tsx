import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { Button } from "../../components/ui/button.js";
import { OPENTAG_COPY, OPENTAG_RAIL_COPY, OPENTAG_STEP_COPY } from "./copy.js";
import { OPENTAG_STEPS, type OpenTagStepId } from "./flow.js";

export type OpenTagHandoff = {
  agentDisplayName: string;
  /** The adopted Template responsibility, when the Agent carries one. */
  responsibility: string | null;
};

/**
 * OpenTag chrome: a slim top bar over a persistent guided-path rail plus one
 * content column.
 *
 * The whole four-step path stays visible so the member always knows how much
 * is left — this entry is a handoff into Feishu, and hiding the last leg would
 * make each step read as if it might be the end. Below the rail sits a quiet
 * summary of what has been established so far, so the current decision never
 * has to restate it.
 *
 * Below the rail's breakpoint the path collapses to a compact horizontal
 * progress line and the summary is dropped: on a phone the rail and the
 * summary together would push the actual decision off the first screen.
 *
 * There is deliberately no Team switcher, Team name, or "finish later" here.
 * OpenTag acts in the OAuth-created or currently selected Team and keeps one
 * decision per screen; the escape hatch is the same Sign out every
 * unauthenticated-recoverable surface offers.
 */
export function OpenTagShell({
  activeStep,
  completedSteps,
  handoff,
  heading,
  children,
}: {
  activeStep: OpenTagStepId;
  completedSteps: readonly OpenTagStepId[];
  handoff: OpenTagHandoff | null;
  /**
   * Replaces the step's standing heading when the step itself has become a
   * different question — currently only the Feishu step, once the Bot half is
   * settled and the wait is longer than usual. The rail, the position, and the
   * step identity are unaffected: this is the same step saying where it is.
   */
  heading?: { why: string; lead: string };
  children: ReactNode;
}): ReactElement {
  const { logout } = useAuth();
  const activeIndex = OPENTAG_STEPS.indexOf(activeStep);
  const stepCopy = heading ?? OPENTAG_STEP_COPY[activeStep];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">{OPENTAG_COPY.productName}</span>
        </span>
        <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={logout}>
          {OPENTAG_COPY.signOut}
        </Button>
      </header>

      <div
        className="mx-auto flex w-full flex-1 flex-col gap-8 md:flex-row md:gap-12"
        style={{
          maxWidth: "60rem",
          paddingInline: "var(--sp-5)",
          paddingTop: "var(--sp-6)",
          paddingBottom: "var(--sp-10)",
        }}
      >
        {/* Wide: the full vertical path plus the quiet handoff summary. */}
        <aside className="hidden md:flex md:flex-col md:shrink-0" style={{ width: "14rem", gap: "var(--sp-6)" }}>
          <StepRail activeStep={activeStep} completedSteps={completedSteps} />
          {handoff && <HandoffSummary handoff={handoff} />}
        </aside>

        {/* Narrow: one compact progress line, no summary. */}
        <div className="md:hidden">
          <CompactProgress activeIndex={activeIndex} total={OPENTAG_STEPS.length} />
        </div>

        <main className="min-w-0 flex-1">
          <p
            className="text-eyebrow uppercase"
            style={{ margin: 0, color: "var(--fg-4)" }}
          >{`${activeIndex + 1} of ${OPENTAG_STEPS.length} · ${OPENTAG_RAIL_COPY[activeStep].title}`}</p>
          <h1
            className="text-title font-semibold"
            style={{ margin: "var(--sp-2) 0 var(--sp-2_5)", color: "var(--fg)" }}
          >
            {stepCopy.why}
          </h1>
          <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
            {stepCopy.lead}
          </p>
          <div key={activeStep} className="fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function StepRail({
  activeStep,
  completedSteps,
}: {
  activeStep: OpenTagStepId;
  completedSteps: readonly OpenTagStepId[];
}): ReactElement {
  return (
    <nav aria-label={OPENTAG_COPY.railLabel}>
      <p className="text-eyebrow uppercase" style={{ margin: "0 0 var(--sp-4)", color: "var(--fg-4)" }}>
        {OPENTAG_COPY.railLabel}
      </p>
      <ol className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none", gap: "var(--sp-4)" }}>
        {OPENTAG_STEPS.map((step, index) => {
          const done = completedSteps.includes(step);
          const active = step === activeStep;
          return (
            <li key={step} className="flex items-start" style={{ gap: "var(--sp-2_5)" }}>
              <StepMarker done={done} active={active} index={index} />
              <span className="min-w-0">
                <span
                  className={`block text-label ${active ? "font-semibold" : "font-medium"}`}
                  style={{ color: active || done ? "var(--fg)" : "var(--fg-3)" }}
                >
                  {OPENTAG_RAIL_COPY[step].title}
                </span>
                <span className="block text-caption" style={{ color: "var(--fg-4)" }}>
                  {OPENTAG_RAIL_COPY[step].rail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepMarker({ done, active, index }: { done: boolean; active: boolean; index: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center text-caption font-semibold"
      style={{
        width: "var(--sp-5)",
        height: "var(--sp-5)",
        borderRadius: "var(--radius-full)",
        border: done || active ? "none" : "var(--hairline) solid var(--border-strong)",
        // Completion is the one place this rail earns color: a done step is a
        // success fact, while the active step stays neutral like every other
        // everyday-action surface.
        background: done ? "var(--success)" : active ? "var(--primary)" : "transparent",
        color: done ? "var(--fg-on-vivid)" : active ? "var(--primary-on)" : "var(--fg-4)",
      }}
    >
      {done ? <Check className="h-3 w-3" /> : index + 1}
    </span>
  );
}

function CompactProgress({ activeIndex, total }: { activeIndex: number; total: number }): ReactElement {
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
      {Array.from({ length: total }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are positional by definition
          key={index}
          aria-hidden="true"
          style={{
            flex: 1,
            height: "var(--sp-0_5)",
            borderRadius: "var(--radius-full)",
            background: index <= activeIndex ? "var(--primary)" : "var(--border)",
          }}
        />
      ))}
    </div>
  );
}

function HandoffSummary({ handoff }: { handoff: OpenTagHandoff }): ReactElement {
  return (
    <div style={{ borderTop: "var(--hairline) solid var(--border-faint)", paddingTop: "var(--sp-4)" }}>
      <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-2)", color: "var(--fg)" }}>
        {OPENTAG_COPY.handoffLabel}
      </p>
      <p className="text-body font-medium" style={{ margin: 0, color: "var(--fg)" }}>
        {handoff.agentDisplayName}
      </p>
      {handoff.responsibility && (
        <p className="text-caption" style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}>
          {handoff.responsibility}
        </p>
      )}
    </div>
  );
}
