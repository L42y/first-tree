import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { listAgentTemplates } from "../../../api/agent-templates.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import { FlowHint, WorkingState } from "../../onboarding/flow-ui.js";
import { resolveOpenTagTemplateChoices } from "../templates.js";

/**
 * One Template, one Agent, in two screens so each carries a single decision:
 * first what the teammate does, then confirming it under a name the member
 * chose. Everything else this Team needs was already established by sign-in.
 *
 * Deliberately absent: Team naming, a Team chooser, a visibility choice, and
 * any Computer or provider configuration. The Agent is created
 * organization-visible and unbound through the ordinary organization-scoped
 * Agent-create boundary, and where it runs is the next step's single decision.
 */
export function StepChooseAgent({
  defaultAgentName,
  onCreate,
  creating,
  error,
  recovery,
}: {
  defaultAgentName: string;
  onCreate: (args: { displayName: string; templateId: string; templateName: string }) => void;
  creating: boolean;
  error: string | null;
  /** Offered when a repeated create collided with an Agent this member already owns. */
  recovery: { displayName: string; onContinue: () => void } | null;
}): ReactElement {
  // Same key the public Template Library uses, so the two surfaces share
  // one cached catalog instead of each holding a private copy.
  const templatesQuery = useQuery({ queryKey: ["agent-template-catalog"], queryFn: listAgentTemplates });
  const { ordered: templates, recommendedSlug } = resolveOpenTagTemplateChoices(templatesQuery.data?.templates ?? []);

  const [displayName, setDisplayName] = useState(defaultAgentName);
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The recommendation leads and is selected until the member picks another
  // one, so the default is the catalog's choice rather than row order.
  const selected = templates.find((template) => template.slug === chosenSlug) ?? templates[0] ?? null;

  const trimmed = displayName.trim();

  if (creating) {
    return <WorkingState label="Creating your Agent…" hint="This takes a moment." />;
  }

  if (confirming && selected) {
    return (
      <ConfirmAgent
        template={selected}
        displayName={displayName}
        onDisplayNameChange={setDisplayName}
        onBack={() => setConfirming(false)}
        onConfirm={() => {
          if (!trimmed) return;
          onCreate({ displayName: trimmed, templateId: selected.id, templateName: selected.name });
        }}
        canConfirm={!!trimmed}
        error={error}
        recovery={recovery}
      />
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-medium" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          What should it do?
        </legend>
        {templatesQuery.isPending ? (
          <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
            Loading teammates…
          </p>
        ) : templatesQuery.isError ? (
          <FlowHint tone="error" role="alert">
            We couldn't load the teammates right now.{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-label"
              onClick={() => void templatesQuery.refetch()}
            >
              Try again
            </Button>
          </FlowHint>
        ) : templates.length === 0 ? (
          <FlowHint role="status">No teammates are available on this deployment yet.</FlowHint>
        ) : (
          templates.map((template) => (
            <TemplateOption
              key={template.slug}
              template={template}
              recommended={template.slug === recommendedSlug}
              checked={selected?.slug === template.slug}
              onSelect={() => setChosenSlug(template.slug)}
            />
          ))
        )}
      </fieldset>

      <div className="flex">
        <Button type="button" variant="cta" disabled={!selected} onClick={() => setConfirming(true)}>
          <span>Review Agent</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The confirmation half of step one: what was chosen, under a name the member
 * can change, and one button that actually creates the Agent.
 */
function ConfirmAgent({
  template,
  displayName,
  onDisplayNameChange,
  onBack,
  onConfirm,
  canConfirm,
  error,
  recovery,
}: {
  template: AgentTemplatePublicTemplate;
  displayName: string;
  onDisplayNameChange: (next: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  canConfirm: boolean;
  error: string | null;
  recovery: { displayName: string; onContinue: () => void } | null;
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <div
        className="flex flex-col"
        style={{
          gap: "var(--sp-1)",
          padding: "var(--sp-3_5)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
        }}
      >
        <p className="text-body font-medium" style={{ margin: 0, color: "var(--fg)" }}>
          {template.name}
        </p>
        <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
          {template.public.purpose}
        </p>
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="opentag-agent-name" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
          Name your Agent
        </label>
        <Input
          id="opentag-agent-name"
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="e.g. Buddy, Helper"
          maxLength={200}
        />
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
            <Button type="button" variant="outline" onClick={recovery.onContinue}>
              Continue with {recovery.displayName}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <Button type="button" variant="cta" disabled={!canConfirm} onClick={onConfirm}>
          <span>Confirm Agent</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Choose a different teammate
        </Button>
      </div>
    </div>
  );
}

function TemplateOption({
  template,
  recommended,
  checked,
  onSelect,
}: {
  template: AgentTemplatePublicTemplate;
  recommended: boolean;
  checked: boolean;
  onSelect: () => void;
}): ReactElement {
  const exampleTasks = template.public.exampleTasks ?? [];
  return (
    <OptionCard name="opentag-template" checked={checked} onSelect={onSelect}>
      <div className="min-w-0">
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <span className="text-body font-medium">{template.name}</span>
          {recommended && (
            <span
              className="text-eyebrow uppercase"
              style={{
                padding: "var(--sp-0_5) var(--sp-1_5)",
                borderRadius: "var(--radius-chip)",
                // Neutral by design: a recommendation is neither success nor
                // liveness, and green is reserved for those (DESIGN.md §3).
                background: "var(--bg-active)",
                color: "var(--fg-2)",
              }}
            >
              Recommended
            </span>
          )}
        </div>
        <div className="text-caption text-muted-foreground">{template.public.tagline}</div>
        {/* Real example work from the Template, shown so the choice is judged
            on what the teammate does rather than on its name. Read-only here:
            continuing a specific first task in Feishu belongs to first use. */}
        {exampleTasks.length > 0 && (
          <ul
            className="flex flex-col"
            style={{ margin: "var(--sp-1_5) 0 0", padding: 0, listStyle: "none", gap: "var(--sp-0_5)" }}
          >
            {exampleTasks.slice(0, 3).map((task) => (
              <li key={task} className="text-caption" style={{ color: "var(--fg-4)" }}>
                “{task}”
              </li>
            ))}
          </ul>
        )}
      </div>
    </OptionCard>
  );
}
