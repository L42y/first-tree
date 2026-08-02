import { type AgentTemplatePublicTemplate, agentTemplateIntentPath, agentTemplateSlugSchema } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { trackEvent } from "../../analytics.js";
import { getAgentTemplate } from "../../api/agent-templates.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { Button } from "../../components/ui/button.js";
import { TemplateUseIntent } from "./template-use-intent.js";

function DetailSkeleton() {
  return <p className="text-body text-fg-3">Loading template…</p>;
}

function NotFound() {
  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-card p-6 text-center">
      <p className="text-body text-fg-2">We couldn&apos;t find that template. It may have been removed.</p>
      <Button asChild variant="outline" className="mt-4">
        <Link to="/templates">Browse all templates</Link>
      </Button>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-card p-6 text-center">
      <p className="text-body text-fg-2">We couldn&apos;t load this template. This is usually temporary.</p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function RetiredNotice({ template }: { template: AgentTemplatePublicTemplate }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-card p-5">
      <p className="text-body text-fg-2">
        This template has been retired and can no longer be used for a new agent. Agents already created from it keep
        working from the resources their team imported.
      </p>
      {template.replacement && (
        <p className="text-body text-fg-2" style={{ marginTop: "var(--sp-2)" }}>
          A newer template is available:{" "}
          <Link to={`/templates/${template.replacement.slug}`} className="text-primary underline underline-offset-2">
            {template.replacement.name}
          </Link>
        </p>
      )}
    </div>
  );
}

function ProfileSection({ label, children }: { label: string; children: string }) {
  if (!children) return null;
  return (
    <section>
      <h2 className="text-label font-medium text-fg-2">{label}</h2>
      <p className="text-body" style={{ marginTop: "var(--sp-1)" }}>
        {children}
      </p>
    </section>
  );
}

/**
 * Public Agent Template detail. Anonymous and signed-in visitors get the same
 * public-safe projection. `?use=1` is the canonical "use this Template" intent
 * URL: logged-out visitors are sent through `/login` (which preserves this
 * exact relative URL as the OAuth `next`), while signed-in members resolve the
 * intent into onboarding or an explicit Team choice.
 */
export function TemplateDetailPage() {
  const { slug: rawSlug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, meLoaded, memberships } = useAuth();
  const slugResult = agentTemplateSlugSchema.safeParse(rawSlug ?? "");
  const slug = slugResult.success ? slugResult.data : null;
  const intent = new URLSearchParams(location.search).get("use") === "1";

  const detailQuery = useQuery({
    queryKey: ["agent-template", slug],
    queryFn: () => getAgentTemplate(slug as string),
    enabled: slug !== null,
    retry: false,
  });
  const template = detailQuery.data ?? null;

  // One deduped detail view per mount, only once a real detail rendered.
  const viewTrackedRef = useRef(false);
  useEffect(() => {
    if (viewTrackedRef.current || !template) return;
    viewTrackedRef.current = true;
    trackEvent("agent_template_detail_view", {
      slug: template.slug,
      status: template.status,
      authenticated: isAuthenticated,
    });
  }, [template, isAuthenticated]);

  function handleUseStarted(activeTemplate: AgentTemplatePublicTemplate): void {
    trackEvent("agent_template_use_started", {
      slug: activeTemplate.slug,
      authenticated: isAuthenticated,
      team_count: isAuthenticated ? memberships.length : 0,
    });
    navigate(agentTemplateIntentPath(activeTemplate.slug));
  }

  // Intent resolution. The logged-out bounce carries the EXACT intent URL
  // (pathname + `use=1`) through router state so LoginPage threads it into the
  // OAuth `next` unchanged.
  if (intent) {
    if (!isAuthenticated) {
      return <Navigate to="/login" replace state={{ from: location }} />;
    }
    if (!meLoaded) {
      return (
        <div className="landing-marketing flex min-h-screen items-center justify-center bg-background text-body text-fg-3">
          Loading…
        </div>
      );
    }
    if (template?.status === "active") {
      return <TemplateUseIntent template={template} />;
    }
    // A retired/unavailable Template cannot start a new agent — fall through
    // to the ordinary detail rendering, which explains the state.
  }

  return (
    <div className="landing-marketing min-h-screen overflow-y-auto bg-background text-foreground">
      <header className="px-4 py-3">
        <Link
          to="/templates"
          className="inline-flex items-center gap-2 rounded-[var(--radius-input)] px-2 py-1 text-body text-fg-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FirstTreeLogo width={20} height={24} />
          Agent templates
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        {slug === null ||
        (detailQuery.isError && detailQuery.error instanceof ApiError && detailQuery.error.status === 404) ? (
          <NotFound />
        ) : detailQuery.isPending ? (
          <DetailSkeleton />
        ) : detailQuery.isError || !template ? (
          <LoadError onRetry={() => void detailQuery.refetch()} />
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
            <div>
              <h1 className="text-headline">{template.name}</h1>
              <p className="text-body text-fg-2" style={{ marginTop: "var(--sp-2)" }}>
                {template.public.tagline}
              </p>
            </div>

            {template.status === "retired" && <RetiredNotice template={template} />}

            <ProfileSection label="What it does">{template.public.purpose}</ProfileSection>
            <ProfileSection label="Who it's for">{template.public.targetUsers}</ProfileSection>
            <ProfileSection label="What you get">{template.public.userValue}</ProfileSection>
            <ProfileSection label="Guidance it adds">{template.public.instructionsSummary}</ProfileSection>
            <ProfileSection label="Tools and skills">{template.public.toolsAndSkillsSummary}</ProfileSection>

            {template.status === "active" && (
              <div>
                <Button variant="cta" onClick={() => handleUseStarted(template)}>
                  Use this template
                </Button>
                <p className="text-caption text-fg-3" style={{ marginTop: "var(--sp-2)" }}>
                  Creates a new agent in your team with this responsibility. You can adjust or remove it before anything
                  is created.
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
