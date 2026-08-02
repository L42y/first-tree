import type { AgentTemplatePublicTemplate, MeMembership } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
 *     written into the wrong one.
 *
 * Team confirmation is a two-phase state machine, because `selectOrganization`
 * clears the whole React Query cache and re-fetches `/me` — and its resolved
 * promise alone is NOT proof the target Team is active (a lost membership
 * reconciles to a fallback org with a resolved promise):
 *
 *   1. `handleConfirm` awaits `selectOrganization(exactOrgId)` and records a
 *      settle marker (the chosen org + the pre-switch memberships identity).
 *   2. The confirmation effect waits until Auth state has actually landed
 *      (the org already matches, or a post-switch memberships array arrived),
 *      then judges: EXACT org match → re-check the onboarding gate against
 *      the NEW org and either hand off to onboarding or open the shared
 *      NewAgentDialog; anything else → recoverable error, nothing is created.
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
  // This also covers a confirmed switch that LANDED on a Team still needing
  // onboarding — the gate above is re-evaluated against the new org's auth
  // state, so Team A's completed gate is never reused for Team B.
  //
  // Deliberately runs after EVERY commit with a ref guard instead of a deps
  // array: the write is keyed by the org it was performed for, so repeats are
  // idempotent (StrictMode double-effects, refreshes), and the effect can
  // never be skipped by a passive-effect scheduling edge while the gate is
  // already showing the onboarding destination.
  const handoffWrittenForRef = useRef<string | null>(null);
  const [handoffWritten, setHandoffWritten] = useState(false);
  useEffect(() => {
    if (!needsOnboarding || !organizationId) {
      handoffWrittenForRef.current = null;
      return;
    }
    if (handoffWrittenForRef.current === organizationId) return;
    handoffWrittenForRef.current = organizationId;
    writeOnboardingTemplateIntent(organizationId, template.slug);
    setHandoffWritten(true);
  });

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(organizationId);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Settle marker for an in-flight confirmation (also the "Confirming team…"
  // UI state): the chosen org plus the pre-switch memberships identity. It is
  // STATE, not a ref — setting it must schedule the render that lets the
  // confirmation effect judge. Auth "has landed" once the selected org
  // already matches or a new memberships array arrives from the post-switch
  // /me — only then is the org comparison trustworthy.
  const [confirmSettle, setConfirmSettle] = useState<{ orgId: string; memberships: MeMembership[] } | null>(null);

  useEffect(() => {
    if (!confirmSettle) return;
    const landed = organizationId === confirmSettle.orgId || memberships !== confirmSettle.memberships;
    if (!landed) return;
    setConfirmSettle(null);
    if (organizationId !== confirmSettle.orgId) {
      // The target membership was lost and Auth reconciled to a fallback
      // Team — never create against a Team the user did not confirm.
      setSwitchError("We couldn't confirm that team — nothing was created. Pick a team and try again.");
      return;
    }
    // Exact Team confirmed. If THIS Team still needs onboarding, the handoff
    // effect above owns the next step — do not open the creation dialog.
    if (needsOnboarding) return;
    setDialogOpen(true);
  }, [confirmSettle, organizationId, memberships, needsOnboarding]);

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
    if (!selectedOrgId || confirmSettle) return;
    setSwitchError(null);
    try {
      await selectOrganization(selectedOrgId);
    } catch {
      // Never open the creation dialog against an unconfirmed Team.
      setSwitchError("We couldn't switch to that team. Try again.");
      return;
    }
    setConfirmSettle({ orgId: selectedOrgId, memberships });
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
          <Button
            variant="cta"
            onClick={() => void handleConfirm()}
            disabled={!selectedOrgId || confirmSettle !== null}
          >
            {confirmSettle !== null ? "Confirming team…" : "Continue"}
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
