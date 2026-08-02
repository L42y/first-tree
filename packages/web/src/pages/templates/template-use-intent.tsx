import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { trackEvent } from "../../analytics.js";
import { useAuth } from "../../auth/auth-context.js";
import { NewAgentDialog } from "../../components/new-agent-dialog.js";
import { Button } from "../../components/ui/button.js";
import { OptionCard } from "../../components/ui/option-card.js";
import { writeOnboardingTemplateIntent } from "../../utils/onboarding-flags.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";

/**
 * Signed-in resolution of the canonical Template intent (`/templates/:slug?use=1`).
 *
 * Two destinations, decided only after `/me` has settled (the caller gates on
 * `meLoaded`, so no org-scoped request fires before the org is resolved):
 *
 *   - Fresh / incomplete onboarding — judged by the SAME gate the workspace
 *     root uses (`shouldEnterOnboarding`), never a parallel re-derivation that
 *     could drift. The slug is stashed as a per-org sessionStorage handoff and
 *     the user continues through the ordinary onboarding flow, whose
 *     create-agent step picks the intent up.
 *   - Everyone else — an explicit Team chooser. Even a single-Team member
 *     confirms the destination Team; a multi-Team member is never silently
 *     written into the wrong one. Only after `selectOrganization` succeeds for
 *     the exact chosen org do we open the shared NewAgentDialog with the
 *     Template preselected.
 */
export function TemplateUseIntent({ template }: { template: AgentTemplatePublicTemplate }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    meLoaded,
    onboardingStep,
    currentOrgHasPersonalAgent,
    onboardingDismissedAt,
    onboardingCompletedAt,
    organizationId,
    memberships,
    selectOrganization,
  } = useAuth();

  const needsOnboarding = shouldEnterOnboarding({
    meLoaded,
    onboardingStep,
    currentOrgHasPersonalAgent,
    onboardingSuppressedAt: onboardingDismissedAt,
    onboardingCompletedAt,
  });

  // Onboarding handoff: write the per-org slug, then enter the ordinary flow.
  // Idempotent, so a StrictMode double-effect or a refresh is harmless.
  const [handoffWritten, setHandoffWritten] = useState(false);
  useEffect(() => {
    if (!needsOnboarding || !organizationId) return;
    writeOnboardingTemplateIntent(organizationId, template.slug);
    setHandoffWritten(true);
  }, [needsOnboarding, organizationId, template.slug]);

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(organizationId);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (needsOnboarding && organizationId) {
    if (!handoffWritten) {
      return (
        <div className="landing-marketing flex min-h-screen items-center justify-center bg-background text-body text-fg-3">
          Loading…
        </div>
      );
    }
    return <Navigate to="/onboarding" replace />;
  }

  async function handleConfirm(): Promise<void> {
    if (!selectedOrgId || switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await selectOrganization(selectedOrgId);
    } catch {
      // Never open the creation dialog against an unconfirmed Team.
      setSwitching(false);
      setSwitchError("We couldn't switch to that team. Try again.");
      return;
    }
    setSwitching(false);
    setDialogOpen(true);
  }

  return (
    <div className="landing-marketing min-h-screen overflow-y-auto bg-background text-foreground">
      <header className="px-4 py-3">
        <Link
          to={`/templates/${template.slug}`}
          className="inline-flex items-center gap-2 rounded-[var(--radius-input)] px-2 py-1 text-body text-fg-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          ← {template.name}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-md px-4 pb-16 pt-8">
        <h1 className="text-headline">Start with {template.name}</h1>
        <p className="text-body text-fg-2" style={{ marginTop: "var(--sp-2)" }}>
          Choose the team your new agent will join. Its instructions, skills, and tools are imported into that team when
          the agent is created.
        </p>

        <div className="mt-6 flex flex-col" style={{ gap: "var(--sp-2)" }}>
          {memberships.map((membership) => (
            <OptionCard
              key={membership.id}
              name="template-intent-team"
              checked={selectedOrgId === membership.organizationId}
              onSelect={() => setSelectedOrgId(membership.organizationId)}
            >
              <div className="min-w-0">
                <div className="text-body font-medium">{membership.organizationName}</div>
                {membership.organizationId === organizationId && (
                  <div className="text-caption text-muted-foreground">Current team</div>
                )}
              </div>
            </OptionCard>
          ))}
        </div>

        {switchError && (
          <p className="text-caption text-destructive" role="alert" style={{ marginTop: "var(--sp-2)" }}>
            {switchError}
          </p>
        )}

        <div className="mt-6">
          <Button variant="cta" onClick={() => void handleConfirm()} disabled={!selectedOrgId || switching}>
            {switching ? "Switching team…" : "Continue"}
          </Button>
        </div>
      </main>

      <NewAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialTemplateSlug={template.slug}
        onCreated={(agent, _runtime, templateCount) => {
          setDialogOpen(false);
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: ["activity"] });
          trackEvent("agent_create_draft_open", { template_count: templateCount });
          navigate(`/?c=draft&with=${encodeURIComponent(agent.uuid)}`);
        }}
      />
    </div>
  );
}
