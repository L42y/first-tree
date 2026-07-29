import { AGENT_TEMPLATE_MAX_SELECTION, type AgentTemplateCatalogItem } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { listAgentTemplates } from "../api/agent-templates.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";

type TemplateRouteState = {
  fromNewAgent?: boolean;
  selectedTemplateIds?: string[];
};

export function AgentTemplatesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = (location.state ?? {}) as TemplateRouteState;
  const templatesQuery = useQuery({
    queryKey: ["agent-templates"],
    queryFn: listAgentTemplates,
  });
  const templates = useMemo(() => templatesQuery.data?.items ?? [], [templatesQuery.data]);
  const availableIds = useMemo(() => new Set(templates.map((template) => template.id)), [templates]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => routeState.selectedTemplateIds ?? []);
  const [activeId, setActiveId] = useState<string | null>(() => routeState.selectedTemplateIds?.[0] ?? null);

  useEffect(() => {
    if (templates.length === 0) return;
    setSelectedIds((current) => current.filter((id) => availableIds.has(id)));
    setActiveId((current) => (current && availableIds.has(current) ? current : (templates[0]?.id ?? null)));
  }, [availableIds, templates]);

  const activeTemplate = templates.find((template) => template.id === activeId) ?? null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  function toggleTemplate(templateId: string): void {
    setSelectedIds((current) => {
      if (current.includes(templateId)) return current.filter((id) => id !== templateId);
      if (current.length >= AGENT_TEMPLATE_MAX_SELECTION) return current;
      return [...current, templateId];
    });
  }

  function continueToNewAgent(): void {
    navigate("/team", {
      state: {
        openNewAgent: true,
        templateIds: selectedIds,
      },
    });
  }

  const continueLabel =
    selectedIds.length > 0
      ? `Use ${selectedIds.length === 1 ? "this template" : `${selectedIds.length} templates`}`
      : routeState.fromNewAgent
        ? "Continue without a template"
        : "Create an agent without a template";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3 pb-2">
        <div>
          <h1 className="m-0 text-subtitle" style={{ color: "var(--fg)" }}>
            Agent templates
          </h1>
          <p className="m-0 mt-1 text-label" style={{ color: "var(--fg-3)" }}>
            Choose ready-made instructions and capabilities, then finish setup in New Agent.
          </p>
        </div>
        <div className="flex-1" />
        <Button variant="cta" size="sm" onClick={continueToNewAgent}>
          {continueLabel}
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {templatesQuery.isLoading ? (
        <TemplateBrowserSkeleton />
      ) : templatesQuery.error ? (
        <div className="py-8 text-body text-destructive">Could not load Agent templates.</div>
      ) : templates.length === 0 ? (
        <div className="py-8">
          <div className="text-body font-medium">No templates are available yet.</div>
          <p className="m-0 mt-1 text-caption text-muted-foreground">
            You can still create an Agent and configure its instructions and capabilities yourself.
          </p>
        </div>
      ) : (
        <div
          className="grid min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-border md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]"
          style={{ background: "var(--bg-raised)" }}
        >
          <div className="min-w-0 border-b border-border md:border-b-0 md:border-r">
            <div
              className="text-label font-medium"
              style={{
                padding: "var(--sp-2_5) var(--sp-3)",
                color: "var(--fg-2)",
                borderBottom: "var(--hairline) solid var(--border)",
              }}
            >
              Templates
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-1.5">
              {templates.map((template) => (
                <TemplateListRow
                  key={template.id}
                  template={template}
                  active={template.id === activeId}
                  selected={selectedSet.has(template.id)}
                  selectionDisabled={
                    selectedIds.length >= AGENT_TEMPLATE_MAX_SELECTION && !selectedSet.has(template.id)
                  }
                  onOpen={() => setActiveId(template.id)}
                  onToggle={() => toggleTemplate(template.id)}
                />
              ))}
            </div>
          </div>

          <div className="min-w-0 overflow-y-auto">
            {activeTemplate ? (
              <TemplateDetail
                template={activeTemplate}
                selected={selectedSet.has(activeTemplate.id)}
                selectionDisabled={
                  selectedIds.length >= AGENT_TEMPLATE_MAX_SELECTION && !selectedSet.has(activeTemplate.id)
                }
                onToggle={() => toggleTemplate(activeTemplate.id)}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateListRow({
  template,
  active,
  selected,
  selectionDisabled,
  onOpen,
  onToggle,
}: {
  template: AgentTemplateCatalogItem;
  active: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-[var(--radius-input)]",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button type="button" className="flex min-w-0 flex-1 flex-col items-start gap-1 p-2 text-left" onClick={onOpen}>
        <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {template.title}
        </span>
        <span className="line-clamp-2 text-caption text-muted-foreground">{template.summary}</span>
      </button>
      <button
        type="button"
        aria-label={`${selected ? "Remove" : "Add"} ${template.title}`}
        aria-pressed={selected}
        disabled={selectionDisabled}
        onClick={onToggle}
        className={cn(
          "mt-2 mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] border transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-transparent hover:border-ring",
          selectionDisabled && "opacity-40",
        )}
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function TemplateDetail({
  template,
  selected,
  selectionDisabled,
  onToggle,
}: {
  template: AgentTemplateCatalogItem;
  selected: boolean;
  selectionDisabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ padding: "var(--sp-5)" }}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-title" style={{ color: "var(--fg)" }}>
            {template.title}
          </h2>
          <p className="m-0 mt-2 text-body" style={{ color: "var(--fg-2)" }}>
            {template.summary}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={selected ? "outline" : "default"}
          disabled={selectionDisabled}
          onClick={onToggle}
        >
          {selected ? "Remove" : "Add template"}
        </Button>
      </div>

      {template.outcomes.length > 0 ? (
        <DetailSection title="What this helps you do">
          <ul className="m-0 space-y-1 pl-5 text-body" style={{ color: "var(--fg-2)" }}>
            {template.outcomes.map((outcome) => (
              <li key={outcome}>{outcome}</li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title="Custom instructions">
        <div
          className="whitespace-pre-wrap rounded-[var(--radius-input)] p-3 font-mono text-caption"
          style={{ color: "var(--fg-2)", background: "var(--bg-sunken)" }}
        >
          {template.customInstructions}
        </div>
      </DetailSection>

      <DetailSection title="Capabilities">
        {template.skills.length === 0 && template.mcp.length === 0 ? (
          <p className="m-0 text-body text-muted-foreground">No additional Skills or MCP servers.</p>
        ) : (
          <div className="space-y-3">
            {template.skills.map((skill) => (
              <div key={`skill:${skill.name}`} className="flex items-start gap-2">
                <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <div className="text-body font-medium">{skill.name}</div>
                  <div className="text-caption text-muted-foreground">{skill.description}</div>
                </div>
              </div>
            ))}
            {template.mcp.map((server) => (
              <div key={`mcp:${server.name}`} className="flex items-baseline gap-2">
                <span className="text-body font-medium">{server.name}</span>
                <span className="text-caption text-muted-foreground">MCP · {server.transport}</span>
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-label font-medium" style={{ color: "var(--fg)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function TemplateBrowserSkeleton() {
  return (
    <div className="grid min-h-72 animate-pulse rounded-[var(--radius-panel)] border border-border md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
      <div className="border-b border-border p-3 md:border-b-0 md:border-r">
        <div className="h-4 w-24 rounded-[var(--radius-chip)] bg-muted" />
        <div className="mt-4 h-12 rounded-[var(--radius-input)] bg-muted" />
        <div className="mt-2 h-12 rounded-[var(--radius-input)] bg-muted" />
      </div>
      <div className="p-5">
        <div className="h-5 w-48 rounded-[var(--radius-chip)] bg-muted" />
        <div className="mt-3 h-4 w-3/4 rounded-[var(--radius-chip)] bg-muted" />
      </div>
    </div>
  );
}
