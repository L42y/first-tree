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
 * Team confirmation is a state machine with an explicit in-flight phase,
 * because `selectOrganization` clears the whole React Query cache, re-fetches
 * `/me`, and writes the target selected-org BEFORE `/me` confirms it:
 *
 *   1. `handleConfirm` SYNCHRONOUSLY enters the `switching` phase (exact
 *      target + pre-switch memberships identity) — the UI disables instantly,
 *      double-clicks can't start concurrent switches, and the generic
 *      onboarding gate is suppressed while ANY confirmation is in flight.
 *   2. Only after the switch promise resolved AND the post-switch auth
 *      snapshot landed does the confirmation effect judge: EXACT org match →
 *      re-check the onboarding gate against THAT Team and explicitly choose
 *      handoff + onboarding or the shared NewAgentDialog; anything else
 *      (reject, fallback) → recoverable error, no handoff for any Team the
 *      user never confirmed, nothing is created.
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

  // Team switch in-flight phase. Established SYNCHRONOUSLY on click — a real
  // `selectOrganization` writes the target selected-org before `/me` confirms
  // it, so without this phase the generic onboarding gate could hand off or
  // navigate for a Team whose membership was never confirmed (or for a
  // fallback the user never picked).
  type TeamSwitch = { targetOrgId: string; preMemberships: MeMembership[]; promiseResolved: boolean };
  const [teamSwitch, setTeamSwitch] = useState<TeamSwitch | null>(null);
  // Explicit, post-confirmation onboarding destination. Set ONLY by the
  // confirmation effect after the exact target is proven — never by the
  // generic gate during a switch.
  const [handoffTarget, setHandoffTarget] = useState<string | null>(null);
  // The org this page mounted with — the ONLY Team the generic (no explicit
  // choice) onboarding handoff may ever fire for. After any switch attempt, a
  // fallback Team that happens to need onboarding must NOT receive a handoff.
  const mountOrgRef = useRef<string | null>(organizationId);

  // Generic onboarding handoff (no explicit Team choice): the member landed
  // here while their CURRENT Team still needs onboarding. Runs after EVERY
  // commit with a ref guard instead of a deps array so a passive-effect
  // scheduling edge can never skip it while the gate is already showing the
  // onboarding destination; the write is keyed by the org it was performed
  // for, so repeats are idempotent (StrictMode double-effects, refreshes).
  const handoffWrittenForRef = useRef<string | null>(null);
  const [handoffWritten, setHandoffWritten] = useState(false);
  useEffect(() => {
    if (teamSwitch) return; // confirmation in flight: no generic handoff
    if (!needsOnboarding || !organizationId || organizationId !== mountOrgRef.current) {
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

  // Confirmation judgement — only after the switch promise resolved AND the
  // post-switch auth snapshot landed (the org already matches, or a fresh
  // memberships array arrived from the post-switch /me).
  useEffect(() => {
    if (!teamSwitch?.promiseResolved) return;
    const landed = organizationId === teamSwitch.targetOrgId || memberships !== teamSwitch.preMemberships;
    if (!landed) return;
    const target = teamSwitch.targetOrgId;
    setTeamSwitch(null);
    if (organizationId !== target) {
      // The target membership was lost and Auth reconciled to a fallback
      // Team — never create against a Team the user did not confirm, and
      // never hand off to that fallback either.
      setSwitchError("We couldn't confirm that team — nothing was created. Pick a team and try again.");
      return;
    }
    // Exact Team confirmed. If THIS Team still needs onboarding, hand off
    // explicitly for it — do not open the creation dialog.
    if (needsOnboarding) {
      writeOnboardingTemplateIntent(target, template.slug);
      setHandoffTarget(target);
      return;
    }
    setDialogOpen(true);
  }, [teamSwitch, organizationId, memberships, needsOnboarding, template.slug]);

  // Explicit confirmed onboarding destination (post-confirmation only).
  if (handoffTarget) {
    return <Navigate to="/onboarding" replace />;
  }

  // Generic onboarding destination — initial landing on a Team that still
  // needs onboarding. Never while a confirmation is in flight, and never for
  // a Team other than the one this page mounted with.
  if (!teamSwitch && needsOnboarding && organizationId && organizationId === mountOrgRef.current) {
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
    if (!selectedOrgId || teamSwitch) return;
    setSwitchError(null);
    // Enter the switching phase IMMEDIATELY — before any async work — so the
    // UI disables, concurrent clicks are ignored, and the generic onboarding
    // gate stays suppressed for the whole flight.
    const request: TeamSwitch = { targetOrgId: selectedOrgId, preMemberships: memberships, promiseResolved: false };
    setTeamSwitch(request);
    try {
      await selectOrganization(selectedOrgId);
    } catch {
      // Never open the creation dialog against an unconfirmed Team.
      setTeamSwitch(null);
      setSwitchError("We couldn't switch to that team. Try again.");
      return;
    }
    setTeamSwitch((prev) =>
      prev && prev.targetOrgId === request.targetOrgId ? { ...prev, promiseResolved: true } : prev,
    );
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
          <Button variant="cta" onClick={() => void handleConfirm()} disabled={!selectedOrgId || teamSwitch !== null}>
            {teamSwitch !== null ? "Confirming team…" : "Continue"}
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
