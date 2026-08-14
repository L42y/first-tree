import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { OPENTAG_COPY, OPENTAG_RAIL_COPY, OPENTAG_STEP_COPY } from "./copy.js";
import { OPENTAG_STEPS, type OpenTagStepId } from "./flow.js";
import { OpenTagLogo } from "./opentag-logo.js";

/**
 * OpenTag chrome: a slim top bar over a persistent grouped rail and one
 * content column. On a phone the rail becomes a compact four-part progress
 * indicator so the current decision remains near the top of the screen.
 */
export function OpenTagShell({
  activeStep,
  completedSteps,
  stepCopy,
  children,
}: {
  activeStep: OpenTagStepId;
  completedSteps: readonly OpenTagStepId[];
  stepCopy?: { why: string; lead: string };
  children: ReactNode;
}): ReactElement {
  const { logout } = useAuth();
  const activeIndex = OPENTAG_STEPS.indexOf(activeStep);
  const visibleStepCopy = stepCopy ?? OPENTAG_STEP_COPY[activeStep];
  const activeGroup = activeIndex < 2 ? "Create agent" : "Start in Feishu";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header
        className="flex items-center justify-between border-b border-border-faint"
        style={{ padding: "var(--sp-4) var(--sp-5)" }}
      >
        <OpenTagLogo />
        <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={logout}>
          {OPENTAG_COPY.signOut}
        </Button>
      </header>

      <div
        className="mx-auto flex w-full flex-1 flex-col md:grid"
        style={{
          maxWidth: "calc(var(--sp-95) * 2 + var(--sp-70) + var(--sp-10))",
          gridTemplateColumns: "calc(var(--sp-45) + var(--sp-7)) minmax(0, calc(var(--sp-95) * 2 + var(--sp-2)))",
          columnGap: "var(--sp-10)",
          paddingInline: "var(--sp-5)",
          paddingTop: "var(--sp-10)",
          paddingBottom: "var(--sp-10)",
        }}
      >
        <aside className="hidden md:block">
          <StepRail activeStep={activeStep} completedSteps={completedSteps} />
        </aside>

        {/* Narrow: one compact progress line. */}
        <div className="md:hidden">
          <CompactProgress activeIndex={activeIndex} total={OPENTAG_STEPS.length} />
        </div>

        <main className="min-w-0 flex-1">
          <p
            className="text-eyebrow uppercase"
            style={{ margin: 0, color: "var(--fg-4)" }}
          >{`Step ${activeIndex + 1} of ${OPENTAG_STEPS.length} · ${activeGroup}`}</p>
          <h1
            className="text-title font-semibold"
            style={{ margin: "var(--sp-2) 0 var(--sp-2_5)", color: "var(--fg)" }}
          >
            {visibleStepCopy.why}
          </h1>
          <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
            {visibleStepCopy.lead}
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
      <RailGroup
        label="Create agent"
        steps={OPENTAG_STEPS.slice(0, 2)}
        activeStep={activeStep}
        completedSteps={completedSteps}
      />
      <div style={{ marginTop: "var(--sp-8)" }}>
        <RailGroup
          label="Start in Feishu"
          steps={OPENTAG_STEPS.slice(2)}
          activeStep={activeStep}
          completedSteps={completedSteps}
        />
      </div>
    </nav>
  );
}

function RailGroup({
  label,
  steps,
  activeStep,
  completedSteps,
}: {
  label: string;
  steps: readonly OpenTagStepId[];
  activeStep: OpenTagStepId;
  completedSteps: readonly OpenTagStepId[];
}): ReactElement {
  return (
    <div>
      <p className="text-eyebrow" style={{ margin: "0 0 var(--sp-4)", color: "var(--fg-3)" }}>
        {label}
      </p>
      <ol className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none", gap: "var(--sp-5)" }}>
        {steps.map((step) => {
          const done = completedSteps.includes(step);
          const active = step === activeStep;
          const index = OPENTAG_STEPS.indexOf(step);
          return (
            <li key={step} className="flex items-start" style={{ gap: "var(--sp-2_5)" }}>
              <StepMarker done={done} active={active} index={index} />
              <span className="min-w-0">
                <span
                  className={`block text-label ${active ? "font-semibold" : "font-medium"}`}
                  style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}
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
    </div>
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
        // Keep progress neutral: the active step carries the strongest
        // emphasis while completed steps recede into the background.
        background: active ? "var(--primary)" : done ? "var(--bg-active)" : "transparent",
        color: active ? "var(--primary-on)" : "var(--fg-3)",
      }}
    >
      {done ? <Check className="h-3 w-3" /> : index + 1}
    </span>
  );
}

function CompactProgress({ activeIndex, total }: { activeIndex: number; total: number }): ReactElement {
  return (
    <div
      className="mb-10 grid grid-cols-4"
      role="progressbar"
      aria-label={OPENTAG_COPY.railLabel}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={activeIndex + 1}
      style={{ gap: "var(--sp-2)" }}
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are positional by definition
          key={index}
          aria-hidden="true"
          style={{
            height: "var(--sp-1)",
            borderRadius: "var(--radius-full)",
            background: index <= activeIndex ? "var(--primary)" : "var(--border)",
          }}
        />
      ))}
    </div>
  );
}
