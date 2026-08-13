import { ArrowRight, Bot, Check, CircleCheck, ExternalLink, Laptop, MessageSquareText } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { OptionCard } from "../components/ui/option-card.js";
import { FeishuRegistrationQr } from "../features/feishu/binding-view.js";
import { CommandBox } from "./onboarding/flow-ui.js";
import "./opentag-onboarding-preview-brand.css";

/**
 * DEV-only state-coverage prototype for the confirmed four-step OpenTag shell.
 *
 * One direction, not a visual variant exercise: `step`, `state`, and
 * `viewport` make every review target shareable while fixtures stay local and
 * deterministic. This route never calls an API or writes lifecycle state.
 */

const PREVIEW_STEPS = ["focus", "computer", "feishu", "first-task"] as const;
type PreviewStep = (typeof PREVIEW_STEPS)[number];
type PreviewViewport = "desktop" | "mobile";

const STATE_OPTIONS = {
  focus: [{ value: "ready", label: "Ready / valid" }],
  computer: [
    { value: "no-computer", label: "No Computer / recovery" },
    { value: "ready", label: "Connected / runtime ready" },
  ],
  feishu: [
    { value: "ready", label: "Bot ready to connect" },
    { value: "provisioning", label: "Provisioning / waiting" },
  ],
  "first-task": [
    { value: "waiting", label: "Waiting for real message" },
    { value: "completed", label: "Completed endpoint" },
  ],
} as const;

type PreviewState = (typeof STATE_OPTIONS)[PreviewStep][number]["value"];

const STEP_META: Record<
  PreviewStep,
  {
    number: number;
    group: "Create Agent" | "Start in Feishu";
    railTitle: string;
    railDetail: string;
    title: string;
    lead: string;
  }
> = {
  focus: {
    number: 1,
    group: "Create Agent",
    railTitle: "Shape your Agent",
    railDetail: "Focus & name",
    title: "What should your Agent do?",
    lead: "Choose the kind of work you want to delegate. We'll use the matching Template as its starting setup, and you can refine it later.",
  },
  computer: {
    number: 2,
    group: "Create Agent",
    railTitle: "Set up its Runtime",
    railDetail: "Computer & Coding Agent",
    title: "Connect your first Computer",
    lead: "Install the OpenTag client on the Computer where this Agent will run.",
  },
  feishu: {
    number: 3,
    group: "Start in Feishu",
    railTitle: "Add to Feishu",
    railDetail: "Connect one Bot",
    title: "Add OpenTag to Feishu",
    lead: "OpenTag prepares a dedicated Feishu Bot for this Agent. Confirm it in Feishu when you are ready.",
  },
  "first-task": {
    number: 4,
    group: "Start in Feishu",
    railTitle: "First task",
    railDetail: "Start working there",
    title: "Send your first task to @OpenTag",
    lead: "Message @OpenTag privately or mention it exactly in a group to start working with your Agent.",
  },
};

const FOCUS_OPTIONS = [
  {
    slug: "team-assistant",
    name: "Team Assistant",
    tagline: "For team questions, decisions, and follow-through.",
    example: "Summarize today's decisions for the wider team",
  },
  {
    slug: "software-engineer",
    name: "Software Engineer",
    tagline: "For debugging, code review, and implementation planning.",
    example: "Turn the requirements from this discussion into an implementation plan.",
  },
  {
    slug: "researcher",
    name: "Researcher",
    tagline: "For evidence gathering, comparison, and decision support.",
    example: "Research this market and identify the main competitors and differentiators.",
  },
] as const;

const DEFAULT_STATE: Record<PreviewStep, PreviewState> = {
  focus: "ready",
  computer: "no-computer",
  feishu: "ready",
  "first-task": "waiting",
};

const PREVIEW_CONNECT_COMMAND =
  "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" +
  "~/.local/bin/first-tree login ft_preview_only";
const PREVIEW_FEISHU_URL = "https://open.feishu.cn/app/preview-only-registration";
export function OpenTagOnboardingPreviewPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const step = parseStep(searchParams.get("step"));
  const state = parseState(step, searchParams.get("state"));
  const viewport = parseViewport(searchParams.get("viewport"));

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "OpenTag onboarding preview";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const setPreview = (next: { step?: PreviewStep; state?: PreviewState; viewport?: PreviewViewport }): void => {
    const nextStep = next.step ?? step;
    const nextState = next.state ?? (next.step ? DEFAULT_STATE[nextStep] : state);
    setSearchParams({ step: nextStep, state: nextState, viewport: next.viewport ?? viewport }, { replace: true });
  };

  return (
    <div className="min-h-screen bg-sunken" style={{ paddingBottom: "var(--sp-20)" }}>
      <div
        className="mx-auto min-h-screen bg-background"
        style={
          viewport === "mobile"
            ? { maxWidth: "calc(var(--sp-95) + var(--sp-2_5))", boxShadow: "var(--shadow-md)" }
            : undefined
        }
      >
        <PreviewShell step={step} viewport={viewport}>
          <StepContent
            step={step}
            state={state}
            viewport={viewport}
            onAdvance={(nextStep) => setPreview({ step: nextStep })}
          />
        </PreviewShell>
      </div>
      <PreviewController
        step={step}
        state={state}
        viewport={viewport}
        onStepChange={(nextStep) => setPreview({ step: nextStep })}
        onStateChange={(nextState) => setPreview({ state: nextState })}
        onViewportChange={(nextViewport) => setPreview({ viewport: nextViewport })}
      />
    </div>
  );
}

function PreviewShell({
  step,
  viewport,
  children,
}: {
  step: PreviewStep;
  viewport: PreviewViewport;
  children: ReactNode;
}): ReactElement {
  const meta = STEP_META[step];
  const mobile = viewport === "mobile";
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header
        className="flex items-center justify-between border-b border-border-faint"
        style={{ padding: "var(--sp-4) var(--sp-5)" }}
      >
        <OpenTagBrand />
        <Button type="button" variant="link" className="h-auto p-0 text-body">
          Sign out
        </Button>
      </header>

      <div
        className={mobile ? "mx-auto flex w-full flex-1 flex-col" : "mx-auto grid w-full flex-1"}
        style={
          mobile
            ? { maxWidth: "var(--sp-95)", padding: "var(--sp-6) var(--sp-5) var(--sp-10)" }
            : {
                maxWidth: "calc(var(--sp-95) * 2 + var(--sp-70) + var(--sp-10))",
                gridTemplateColumns: "calc(var(--sp-45) + var(--sp-7)) minmax(0, calc(var(--sp-95) * 2 + var(--sp-2)))",
                columnGap: "var(--sp-10)",
                padding: "var(--sp-10) var(--sp-5)",
              }
        }
      >
        {mobile ? <MobileProgress activeIndex={meta.number - 1} /> : <DesktopRail step={step} />}
        <main className="min-w-0">
          <p className="text-eyebrow uppercase" style={{ margin: 0, color: "var(--fg-3)" }}>
            Step {meta.number} of 4 · {meta.group}
          </p>
          <h1 className="text-title font-semibold" style={{ margin: "var(--sp-3) 0 var(--sp-3)", color: "var(--fg)" }}>
            {meta.title}
          </h1>
          <p
            className="text-body"
            style={{ margin: "0 0 var(--sp-8)", color: "var(--fg-3)", maxWidth: "var(--sp-95)" }}
          >
            {meta.lead}
          </p>
          {children}
        </main>
      </div>
    </div>
  );
}

function DesktopRail({ step }: { step: PreviewStep }): ReactElement {
  return (
    <nav aria-label="OpenTag setup progress">
      <RailGroup label="Create Agent" steps={PREVIEW_STEPS.slice(0, 2)} activeStep={step} />
      <div style={{ marginTop: "var(--sp-8)" }}>
        <RailGroup label="Start in Feishu" steps={PREVIEW_STEPS.slice(2)} activeStep={step} />
      </div>
    </nav>
  );
}

function RailGroup({
  label,
  steps,
  activeStep,
}: {
  label: string;
  steps: readonly PreviewStep[];
  activeStep: PreviewStep;
}): ReactElement {
  return (
    <div>
      <p className="text-eyebrow uppercase" style={{ margin: "0 0 var(--sp-4)", color: "var(--fg-3)" }}>
        {label}
      </p>
      <ol className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none", gap: "var(--sp-5)" }}>
        {steps.map((candidate) => {
          const meta = STEP_META[candidate];
          const active = candidate === activeStep;
          const complete = meta.number < STEP_META[activeStep].number;
          return (
            <li key={candidate} className="flex items-start" style={{ gap: "var(--sp-3)" }}>
              <span
                aria-hidden="true"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-caption font-semibold"
                style={{
                  border: active || complete ? "none" : "var(--hairline) solid var(--border-strong)",
                  background: active ? "var(--primary)" : complete ? "var(--bg-active)" : "transparent",
                  color: active ? "var(--primary-on)" : "var(--fg-3)",
                }}
              >
                {complete ? <Check className="h-3.5 w-3.5" /> : meta.number}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-body ${active ? "font-semibold" : "font-medium"}`}
                  style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}
                >
                  {meta.railTitle}
                </span>
                <span className="block text-caption" style={{ color: "var(--fg-4)" }}>
                  {meta.railDetail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MobileProgress({ activeIndex }: { activeIndex: number }): ReactElement {
  return (
    <div
      className="mb-10 grid grid-cols-4"
      role="progressbar"
      aria-label="OpenTag setup progress"
      aria-valuemin={1}
      aria-valuemax={4}
      aria-valuenow={activeIndex + 1}
      style={{ gap: "var(--sp-2)" }}
    >
      {PREVIEW_STEPS.map((step, index) => (
        <span
          key={step}
          aria-hidden="true"
          className="h-1 rounded-[var(--radius-full)]"
          style={{ background: index <= activeIndex ? "var(--primary)" : "var(--border)" }}
        />
      ))}
    </div>
  );
}

function StepContent({
  step,
  state,
  viewport,
  onAdvance,
}: {
  step: PreviewStep;
  state: PreviewState;
  viewport: PreviewViewport;
  onAdvance: (step: PreviewStep) => void;
}): ReactElement {
  switch (step) {
    case "focus":
      return <FocusAndNameStep mobile={viewport === "mobile"} onAdvance={() => onAdvance("computer")} />;
    case "computer":
      return state === "no-computer" ? (
        <ComputerRecoveryStep />
      ) : (
        <ComputerReadyStep mobile={viewport === "mobile"} onAdvance={() => onAdvance("feishu")} />
      );
    case "feishu":
      return state === "provisioning" ? (
        <FeishuProvisioningStep />
      ) : (
        <FeishuReadyStep mobile={viewport === "mobile"} onAdvance={() => onAdvance("first-task")} />
      );
    case "first-task":
      return state === "completed" ? <FirstTaskCompletedStep /> : <FirstTaskWaitingStep />;
  }
}

function FocusAndNameStep({ mobile, onAdvance }: { mobile: boolean; onAdvance: () => void }): ReactElement {
  const [focus, setFocus] = useState<(typeof FOCUS_OPTIONS)[number]["slug"]>("team-assistant");
  const [name, setName] = useState("gandy2025 assistant");
  const selected = FOCUS_OPTIONS.find((option) => option.slug === focus) ?? FOCUS_OPTIONS[0];
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="sr-only">Work focus</legend>
        {FOCUS_OPTIONS.map((option) => (
          <OptionCard
            key={option.slug}
            name="preview-work-focus"
            checked={focus === option.slug}
            onSelect={() => setFocus(option.slug)}
          >
            <span className="min-w-0 flex-1">
              <span className={mobile ? "block" : "flex items-center"} style={{ gap: "var(--sp-4)" }}>
                <span className="text-subtitle font-semibold">{option.name}</span>
                {option.slug === "team-assistant" ? (
                  <span
                    className="block text-eyebrow uppercase"
                    style={{ marginTop: mobile ? "var(--sp-1)" : 0, color: "var(--fg-3)" }}
                  >
                    Best for most teams
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
                {option.tagline}
              </span>
            </span>
          </OptionCard>
        ))}
      </fieldset>

      <LabeledDetail label="Example task">{selected.example}</LabeledDetail>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label
          htmlFor="preview-agent-name"
          className="text-label font-semibold uppercase"
          style={{ color: "var(--fg-2)" }}
        >
          Agent name
        </label>
        <Input id="preview-agent-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </div>

      <div className="flex">
        <Button
          type="button"
          variant="cta"
          className={mobile ? "w-full" : undefined}
          disabled={!name.trim()}
          onClick={onAdvance}
        >
          Set up its Runtime <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ComputerReadyStep({ mobile, onAdvance }: { mobile: boolean; onAdvance: () => void }): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <div className="flex items-start" style={{ gap: "var(--sp-4)" }}>
        <span className="surface-sunken inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-panel)]">
          <Laptop className="h-5 w-5" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-subtitle font-semibold">Gandy's MacBook</span>
          <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
            OpenTag client connected
          </span>
        </span>
      </div>
      <PreviewStatusRow state="ok" label="Claude Code is ready on this Computer" />
      <LabeledDetail label="Draft Agent">gandy2025 assistant · Team Assistant</LabeledDetail>
      <div className="flex">
        <Button type="button" variant="cta" className={mobile ? "w-full" : undefined} onClick={onAdvance}>
          Create Agent <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ComputerRecoveryStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <p className="text-label font-semibold uppercase" style={{ margin: 0, color: "var(--fg-2)" }}>
          Set up your first Computer
        </p>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          Install the OpenTag client on the Computer where the Agent should work. The Agent has not been created yet.
        </p>
        <CommandBox command={PREVIEW_CONNECT_COMMAND} />
      </div>
      <PreviewStatusRow state="waiting" label="Waiting for this Computer to connect…" />
      <Button type="button" variant="link" className="h-auto w-fit p-0 text-label">
        Back to Focus & name
      </Button>
    </div>
  );
}

function FeishuReadyStep({ mobile, onAdvance }: { mobile: boolean; onAdvance: () => void }): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <div className="flex items-start" style={{ gap: "var(--sp-4)" }}>
        <span className="surface-sunken inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-panel)]">
          <Bot className="h-5 w-5" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-subtitle font-semibold">OpenTag Bot for gandy2025 assistant</span>
          <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
            One dedicated Bot will carry this Agent into Feishu.
          </span>
        </span>
      </div>
      <div className="flex">
        <Button type="button" variant="cta" className={mobile ? "w-full" : undefined} onClick={onAdvance}>
          Add OpenTag to Feishu <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function FeishuProvisioningStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <FeishuRegistrationQr registrationUrl={PREVIEW_FEISHU_URL} />
      <PreviewStatusRow state="waiting" label="Waiting for Feishu to confirm the Bot…" />
    </div>
  );
}

function FirstTaskWaitingStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <div className="flex items-start" style={{ gap: "var(--sp-4)" }}>
        <span className="surface-sunken inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-panel)]">
          <MessageSquareText className="h-5 w-5" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-subtitle font-semibold">@OpenTag is ready in Feishu</span>
          <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
            Send a private message, or mention the Bot exactly in a group.
          </span>
        </span>
      </div>
      <PreviewStatusRow state="waiting" label="Waiting for your first message to @OpenTag…" />
      <Button type="button" variant="outline" className="w-fit">
        Open Feishu <ExternalLink className="h-4 w-4" />
      </Button>
    </div>
  );
}

function FirstTaskCompletedStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <div className="flex items-start" style={{ gap: "var(--sp-4)" }}>
        <CircleCheck className="h-8 w-8 shrink-0" style={{ color: "var(--fg)" }} aria-hidden="true" />
        <span>
          <span className="block text-title font-semibold">First task received</span>
          <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
            A real Feishu message created the Agent's first Task. OpenTag setup is complete.
          </span>
        </span>
      </div>
      <LabeledDetail label="First message">
        Summarize today's launch discussion and turn it into owners and next steps.
      </LabeledDetail>
      <Button type="button" variant="cta" className="w-fit">
        Open first task <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function LabeledDetail({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <p className="text-label font-semibold uppercase" style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-2)" }}>
        {label}
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {children}
      </p>
    </div>
  );
}

function OpenTagBrand(): ReactElement {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-2_25)" }}>
      <span className="opentag-preview-logo" aria-hidden="true" />
      <span className="opentag-preview-wordmark">OpenTag</span>
    </span>
  );
}

function PreviewStatusRow({ state, label }: { state: "waiting" | "ok"; label: ReactNode }): ReactElement {
  return (
    <div
      className="inline-flex items-center text-label"
      role="status"
      aria-live="polite"
      style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}
    >
      {state === "ok" ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: "var(--sp-2)",
            height: "var(--sp-2)",
            borderRadius: "var(--radius-full)",
            border: "var(--hairline) solid var(--border-strong)",
            background: "var(--bg-raised)",
          }}
        />
      )}
      <span>{label}</span>
    </div>
  );
}

function PreviewController({
  step,
  state,
  viewport,
  onStepChange,
  onStateChange,
  onViewportChange,
}: {
  step: PreviewStep;
  state: PreviewState;
  viewport: PreviewViewport;
  onStepChange: (step: PreviewStep) => void;
  onStateChange: (state: PreviewState) => void;
  onViewportChange: (viewport: PreviewViewport) => void;
}): ReactElement {
  return (
    <aside
      aria-label="Preview controls"
      className={
        viewport === "mobile" ? "fixed right-3 bottom-3 z-50" : "fixed bottom-3 left-1/2 z-50 -translate-x-1/2"
      }
    >
      <details
        className="surface-overlay"
        open={viewport === "desktop"}
        style={{ padding: "var(--sp-3)", maxWidth: "calc(100vw - var(--sp-6))" }}
      >
        <summary className="cursor-pointer text-eyebrow font-semibold uppercase" style={{ color: "var(--fg-3)" }}>
          Preview only
        </summary>
        <div className="flex flex-wrap items-end" style={{ gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
          <PreviewSelect label="Step" value={step} onChange={(value) => onStepChange(parseStep(value))}>
            {PREVIEW_STEPS.map((option) => (
              <option key={option} value={option}>
                {STEP_META[option].number}. {STEP_META[option].railTitle}
              </option>
            ))}
          </PreviewSelect>
          <PreviewSelect label="State" value={state} onChange={(value) => onStateChange(parseState(step, value))}>
            {STATE_OPTIONS[step].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </PreviewSelect>
          <PreviewSelect label="Viewport" value={viewport} onChange={(value) => onViewportChange(parseViewport(value))}>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile · 390</option>
          </PreviewSelect>
        </div>
      </details>
    </aside>
  );
}

function PreviewSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
      <span className="text-eyebrow uppercase" style={{ color: "var(--fg-3)" }}>
        {label}
      </span>
      <select
        className="h-8 rounded-[var(--radius-input)] border border-input bg-background px-2 text-label text-foreground focus-visible:border-ring focus-visible:outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function parseStep(value: string | null): PreviewStep {
  return PREVIEW_STEPS.find((step) => step === value) ?? "focus";
}

function parseState(step: PreviewStep, value: string | null): PreviewState {
  return STATE_OPTIONS[step].find((state) => state.value === value)?.value ?? DEFAULT_STATE[step];
}

function parseViewport(value: string | null): PreviewViewport {
  return value === "mobile" ? "mobile" : "desktop";
}
