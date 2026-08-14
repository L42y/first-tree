import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { listAgentTemplates } from "../../../api/agent-templates.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import { FlowHint } from "../../onboarding/flow-ui.js";
import type { OpenTagDraft } from "../opentag-page.js";
import { openTagTemplateTagline, resolveOpenTagTemplateChoices } from "../templates.js";

/**
 * The complete pre-create focus and name decision. Nothing is persisted here;
 * the draft returns to the page and is materialized only with Step 2's valid
 * computer and coding-agent choice.
 */
export function StepChooseAgent({
  defaultAgentName,
  initialDraft,
  onContinue,
}: {
  defaultAgentName: string;
  initialDraft: OpenTagDraft | null;
  onContinue: (draft: OpenTagDraft) => void;
}): ReactElement {
  const templatesQuery = useQuery({ queryKey: ["agent-template-catalog"], queryFn: listAgentTemplates });
  const { ordered: templates, recommendedSlug } = resolveOpenTagTemplateChoices(templatesQuery.data?.templates ?? []);
  const [displayName, setDisplayName] = useState(initialDraft?.displayName ?? defaultAgentName);
  const [chosenTemplateId, setChosenTemplateId] = useState<string | null>(initialDraft?.templateId ?? null);
  const selected =
    templates.find((template) => template.id === chosenTemplateId) ??
    templates.find((template) => template.slug === recommendedSlug) ??
    templates[0] ??
    null;
  const trimmed = displayName.trim();
  const example = selected?.public.exampleTasks?.[0] ?? null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="sr-only">Work focus</legend>
        {templatesQuery.isPending ? (
          <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
            Loading templates…
          </p>
        ) : templatesQuery.isError ? (
          <FlowHint tone="error" role="alert">
            We couldn't load the templates right now.{" "}
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
          <FlowHint role="status">No templates are available on this deployment yet.</FlowHint>
        ) : (
          templates.map((template) => (
            <TemplateOption
              key={template.id}
              template={template}
              recommended={template.slug === recommendedSlug}
              checked={selected?.id === template.id}
              onSelect={() => setChosenTemplateId(template.id)}
            />
          ))
        )}
      </fieldset>

      {example ? <LabeledDetail label="Example task">{example}</LabeledDetail> : null}

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="opentag-agent-name" className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          Agent name
        </label>
        <Input
          id="opentag-agent-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={200}
        />
      </div>

      <div className="flex">
        <Button
          type="button"
          variant="cta"
          disabled={!selected || !trimmed}
          onClick={() => {
            if (!selected || !trimmed) return;
            onContinue({ templateId: selected.id, templateName: selected.name, displayName: trimmed });
          }}
        >
          Set up its runtime
          <ArrowRight className="h-4 w-4" />
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
  return (
    <OptionCard name="opentag-template" checked={checked} onSelect={onSelect}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center" style={{ gap: "var(--sp-4)" }}>
          <span className="text-subtitle font-semibold">{template.name}</span>
          {recommended ? (
            <span className="text-eyebrow" style={{ color: "var(--fg-3)" }}>
              Best for most teams
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
          {openTagTemplateTagline(template)}
        </span>
      </span>
    </OptionCard>
  );
}

function LabeledDetail({ label, children }: { label: string; children: string }): ReactElement {
  return (
    <div>
      <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-2)" }}>
        {label}
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {children}
      </p>
    </div>
  );
}
