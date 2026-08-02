import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.js";
import { listAgentTemplates } from "../../api/agent-templates.js";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { Button } from "../../components/ui/button.js";

function TemplateCard({ template }: { template: AgentTemplatePublicTemplate }) {
  return (
    <Link
      to={`/templates/${template.slug}`}
      className="block rounded-[var(--radius-panel)] border border-border bg-card p-5 text-card-foreground transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="text-title">{template.name}</div>
      <p className="text-body text-fg-2" style={{ marginTop: "var(--sp-1)" }}>
        {template.public.tagline}
      </p>
      <p className="text-caption text-fg-2" style={{ marginTop: "var(--sp-3)" }}>
        For {template.public.targetUsers}
      </p>
    </Link>
  );
}

/**
 * Public Agent Template Library. Anonymous visitors and signed-in members see
 * the same public-safe catalog — only active Templates, and only the explicit
 * safe projection (identity, tagline, purpose, audience, value, capability
 * summaries). No component payload ever reaches this page.
 */
export function TemplateLibraryPage() {
  const { isAuthenticated } = useAuth();
  const catalogQuery = useQuery({
    queryKey: ["agent-template-catalog"],
    queryFn: listAgentTemplates,
    retry: false,
  });

  // One deduped view per page mount, reported only once the catalog has
  // actually rendered something (a failed load is not a library view).
  const viewTrackedRef = useRef(false);
  useEffect(() => {
    if (viewTrackedRef.current || !catalogQuery.data) return;
    viewTrackedRef.current = true;
    trackEvent("agent_template_library_view", {
      template_count: catalogQuery.data.templates.length,
      authenticated: isAuthenticated,
    });
  }, [catalogQuery.data, isAuthenticated]);

  return (
    <div className="landing-marketing min-h-screen overflow-y-auto bg-background text-foreground">
      <header className="px-4 py-3">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-[var(--radius-input)] px-2 py-1 text-body text-fg-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FirstTreeLogo width={20} height={24} />
          First Tree
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-8">
        <h1 className="text-headline">Agent templates</h1>
        <p className="text-body text-fg-2" style={{ marginTop: "var(--sp-2)" }}>
          Official starting responsibilities for a First Tree agent. Pick one, and its instructions, skills, and tools
          are imported into your team when the agent is created.
        </p>

        <div className="mt-8">
          {catalogQuery.isPending ? (
            <p className="text-body text-fg-2">Loading templates…</p>
          ) : catalogQuery.isError ? (
            <div className="rounded-[var(--radius-panel)] border border-border bg-card p-6 text-center">
              <p className="text-body text-fg-2">
                We couldn&apos;t load the template library. This is usually temporary.
              </p>
              <Button variant="outline" className="mt-4" onClick={() => void catalogQuery.refetch()}>
                Try again
              </Button>
            </div>
          ) : catalogQuery.data.templates.length === 0 ? (
            <p className="text-body text-fg-2">No templates are available yet. Check back soon.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {catalogQuery.data.templates.map((template) => (
                <TemplateCard key={template.id} template={template} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
