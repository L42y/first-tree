import {
  type AgentTemplatePublicTemplate,
  type AgentVisibility,
  orderRuntimeProvidersByPreference,
  runtimeProviderLabel,
} from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getAgentTemplate } from "../../../api/agent-templates.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ConnectedComputerSelect, ConnectedComputerSummary } from "../../../components/connected-computer-select.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import { readOnboardingTemplateIntent } from "../../../utils/onboarding-flags.js";
import { COPY } from "../copy.js";
import { FlowHint, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

// Copy mirrors the New Agent dialog's Visibility block so the two
// agent-creation surfaces read identically (see new-agent-dialog.tsx).
const VISIBILITY_OPTIONS: ReadonlyArray<{ value: AgentVisibility; title: string; description: string }> = [
  {
    value: "organization",
    title: "Visible to your team",
    // Full-consequence disclosure: org-visible means teammates can start work
    // with this agent directly — on the owner's computer and plan. Kept in
    // sync with new-agent-dialog.tsx and profile-edit-dialog.tsx.
    description:
      "Anyone on your team can @mention it and start work with it — it runs on your computer and uses your plan.",
  },
  {
    value: "private",
    title: "Private to you",
    description: "Only you can see and chat with it.",
  },
];

/**
 * Name the agent, choose what it runs, and choose who can use it. The connected
 * computer and detected options come from the previous step; the product does
 * not surface the runtime / client implementation vocabulary here. On success
 * the flow auto-advances to start-chat (the agent-online callback), so this
 * renders form → creating → (timeout fallback) only.
 */
export function StepCreateAgent() {
  const {
    agentDisplayName,
    setAgentDisplayName,
    visibility,
    setVisibility,
    computer,
    organizationId,
    createAgent,
    retryAgent,
    finishLater,
    agentPhase,
    agentError,
    goNext,
    goTo,
    sequence,
  } = useOnboardingFlow();
  const { currentOrgHasPersonalAgent } = useAuth();

  // Template intent handoff from the public `/templates/:slug?use=1` entry.
  // Per-org (sessionStorage); the public-safe detail is fetched so the step
  // can show the responsibility the member picked. Any failure — fetch error,
  // retired Template, invalid/stale handoff — degrades to a recoverable hint
  // and leaves plain create fully available.
  //
  // The onboarding shell lets the member switch Teams while this step stays
  // mounted, so the intent is re-read whenever the selected org changes:
  // every piece of intent state (slug, resolved template, unavailable flag,
  // and the user's Remove decision) belongs to ONE org and is dropped on
  // switch — Team A's Template id or removal must never leak into Team B.
  const [intentOrg, setIntentOrg] = useState<string | null>(organizationId);
  const [intentSlug, setIntentSlug] = useState<string | null>(() =>
    organizationId ? readOnboardingTemplateIntent(organizationId) : null,
  );
  const [intentTemplate, setIntentTemplate] = useState<AgentTemplatePublicTemplate | null>(null);
  const [intentUnavailable, setIntentUnavailable] = useState(false);
  const [intentRemoved, setIntentRemoved] = useState(false);
  if (organizationId !== intentOrg) {
    // Render-time reset (React's recommended derived-state pattern, matching
    // the flow provider's own org-change handling) so the stale intent never
    // paints or submits for the new org.
    setIntentOrg(organizationId);
    setIntentSlug(organizationId ? readOnboardingTemplateIntent(organizationId) : null);
    setIntentTemplate(null);
    setIntentUnavailable(false);
    setIntentRemoved(false);
  }
  const intentFetchSeqRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the invalidation must fire exactly when the committed {org, slug} identity changes; the ref itself is not a dependency.
  useLayoutEffect(() => {
    // Invalidate in-flight lookups from the PREVIOUS committed {org, slug}
    // synchronously at commit. A passive effect would leave a
    // commit-to-effect window where Team A's late success/failure callback
    // could still pass the old sequence and mutate Team B's intent state;
    // layout effects run inside the commit, before any promise callback can
    // interleave.
    intentFetchSeqRef.current += 1;
  }, [organizationId, intentSlug]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: organizationId is part of the committed {org, slug} lookup identity even though the request itself only uses the slug.
  useEffect(() => {
    // Sequence-guarded so a late response for the PREVIOUS org's slug can
    // never overwrite the new org's state. The lookup identity is the
    // committed {organizationId, intentSlug} pair — two Teams may hand off
    // the SAME slug, and the new Team still needs its own request (the slug
    // string alone does not change).
    const seq = ++intentFetchSeqRef.current;
    if (!intentSlug) return;
    getAgentTemplate(intentSlug)
      .then((template) => {
        if (seq !== intentFetchSeqRef.current) return;
        if (template.status === "active") setIntentTemplate(template);
        else setIntentUnavailable(true);
      })
      .catch(() => {
        if (seq !== intentFetchSeqRef.current) return;
        setIntentUnavailable(true);
      });
  }, [organizationId, intentSlug]);
  const activeIntentTemplate = intentTemplate && !intentRemoved ? intentTemplate : null;
  // An explicit intent whose lookup is still in flight. While pending,
  // creation is BLOCKED (visible resolving state + handler guard) so a
  // slow/hung lookup can never silently turn an explicit adoption into a
  // plain Agent; the explicit Remove escape unlocks plain creation and a
  // late response can never reapply or re-block.
  const intentPending = intentSlug !== null && !intentTemplate && !intentUnavailable && !intentRemoved;

  // Fresh onboarding entry always lands on the opening step and walks forward
  // (inferInitialStepIndex ignores server readiness), so a member who already
  // created their personal agent in this org — e.g. a refresh / new tab after
  // the agent came online but before start-chat — can reach this step again.
  // Creating here would make a duplicate agent, so skip straight past the form.
  // Gated on `idle` + the one-shot ref so it never double-advances the normal
  // create path, which advances itself via the flow's onAgentOnline -> goNext.
  const skippedExistingAgent = useRef(false);
  useEffect(() => {
    if (skippedExistingAgent.current) return;
    if (currentOrgHasPersonalAgent && agentPhase === "idle") {
      skippedExistingAgent.current = true;
      goNext();
    }
  }, [currentOrgHasPersonalAgent, agentPhase, goNext]);

  const trimmed = agentDisplayName.trim();
  const canCreate =
    !!trimmed &&
    !!computer.connectedClient &&
    !!computer.selectedRuntime &&
    computer.okRuntimes.includes(computer.selectedRuntime) &&
    !intentPending &&
    agentPhase === "idle";

  // The coding-agent picker lives HERE now (moved from connect-computer). Always
  // a list — even for one. Selection and option order come from the shared
  // Codex-first catalog preference in `useComputerConnection`.
  const { okRuntimes, selectedRuntime, setSelectedRuntime } = computer;
  const orderedOkRuntimes = useMemo(() => orderRuntimeProvidersByPreference(okRuntimes), [okRuntimes]);

  // Coding-agent pills to render. When the computer drops mid-form, okRuntimes
  // empties but `selectedRuntime` keeps the last pick — so we still show THAT
  // agent (disabled) rather than letting the whole field vanish and the form
  // jump. A disabled pill + the reconnect hint reads as "your agent's here, just
  // temporarily unreachable", not "it's gone".
  const connected = !!computer.connectedClient;
  const displayProviders = connected
    ? orderedOkRuntimes
    : computer.connectedClients.length === 0 && selectedRuntime
      ? [selectedRuntime]
      : [];

  if (agentPhase === "creating") {
    return <WorkingState label={COPY.createAgent.creating} hint={COPY.createAgent.creatingHint} />;
  }

  if (agentPhase === "timeout") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {/* Slow-start, not a failure: the shell's step h1 already heads the screen,
            so one plain paragraph, then two paths — keep waiting (re-poll) or the
            graceful, resumable "finish later" so a genuinely-stuck runtime is never
            a dead end. */}
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {COPY.createAgent.timeoutBody}
        </p>
        <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
          <Button type="button" onClick={() => void retryAgent()}>
            {COPY.createAgent.keepWaiting}
          </Button>
          <button
            type="button"
            className="text-label font-medium underline underline-offset-2"
            style={{ color: "var(--fg-3)" }}
            onClick={() => void finishLater()}
          >
            {COPY.finishLater}
          </button>
        </div>
      </div>
    );
  }

  const handleCreate = (): void => {
    // Guard the handler itself, not just the button: an unresolved explicit
    // intent must never submit as a plain create.
    if (!canCreate || intentPending || !computer.connectedClient || !computer.selectedRuntime) return;
    void createAgent({
      displayName: trimmed,
      clientId: computer.connectedClient.id,
      runtimeProvider: computer.selectedRuntime,
      visibility,
      organizationId,
      ...(activeIntentTemplate ? { templateIds: [activeIntentTemplate.id] } : {}),
    });
  };

  const executionPicker = (
    <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
      <legend
        className="text-label font-medium"
        style={{
          color: "var(--fg-2)",
          marginBottom: "var(--sp-1)",
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-2)",
        }}
      >
        {COPY.createAgent.codingAgentLabel}
        {/* Only a genuinely disconnected state is "Not ready". With several
            online computers and no selection, the dropdown itself is the
            required next action. */}
        {computer.connectedClients.length === 0 && (
          <span
            className="inline-flex items-center text-caption font-medium"
            style={{
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              borderRadius: "var(--radius-chip)",
              background: "var(--state-needs-you-soft)",
              color: "var(--fg-needs-you-strong)",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: "var(--sp-1_5)",
                height: "var(--sp-1_5)",
                borderRadius: "var(--radius-full)",
                background: "var(--state-needs-you)",
              }}
            />
            {COPY.createAgent.codingAgentNotReady}
          </span>
        )}
      </legend>

      {computer.connectedClients.length > 1 ? (
        <ConnectedComputerSelect
          clients={computer.connectedClients}
          value={computer.selectedClientId}
          onChange={computer.setSelectedClientId}
          id="onboarding-agent-computer"
        />
      ) : computer.connectedClients.length === 1 && computer.connectedClients[0] ? (
        <ConnectedComputerSummary client={computer.connectedClients[0]} />
      ) : null}

      {connected && !computer.capabilitiesLoaded ? (
        <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
          Detecting what this computer can run…
        </p>
      ) : displayProviders.length > 0 ? (
        <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
          {displayProviders.map((provider) => (
            <OptionCard
              key={provider}
              name="onboarding-coding-agent"
              layout="pill"
              checked={selectedRuntime === provider}
              onSelect={() => setSelectedRuntime(provider)}
              disabled={!connected}
            >
              <span className="text-body">{runtimeProviderLabel(provider)}</span>
            </OptionCard>
          ))}
        </div>
      ) : null}
    </fieldset>
  );

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        {COPY.createAgent.subtitle}
      </p>

      {/* Template intent handoff. Default-selected and removable; with no
          intent this block renders nothing and the step is byte-identical to
          the ordinary create path. */}
      {intentPending && (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
            Resolving your template…
          </p>
          <div>
            {/* Explicit escape hatch: plain creation without waiting. Once
                removed, a late lookup can never reapply or re-block. */}
            <Button type="button" variant="ghost" size="sm" onClick={() => setIntentRemoved(true)}>
              Create without this template
            </Button>
          </div>
        </div>
      )}
      {activeIntentTemplate && (
        <div className="rounded-[var(--radius-panel)] border border-border px-3 py-2 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-body font-medium">{activeIntentTemplate.name}</div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setIntentRemoved(true)}>
              Remove
            </Button>
          </div>
          <div className="text-caption text-muted-foreground">{activeIntentTemplate.public.tagline}</div>
          <div className="text-caption text-muted-foreground">{activeIntentTemplate.public.purpose}</div>
        </div>
      )}
      {intentUnavailable && !intentRemoved && !activeIntentTemplate && (
        <FlowHint>{COPY.createAgent.templateIntentUnavailable}</FlowHint>
      )}

      {/* Coding agent — always a list (even for one), default Codex when available.
          Stays visible (disabled) when the computer drops, so the field never
          vanishes from under the user. */}
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-agent-name" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
          {COPY.createAgent.nameLabel}
        </label>
        <Input
          id="onboarding-agent-name"
          value={agentDisplayName}
          onChange={(e) => setAgentDisplayName(e.target.value)}
          placeholder="e.g. Buddy, Helper"
          maxLength={200}
        />
      </div>

      {executionPicker}

      <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-medium" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          Who can use it?
        </legend>
        {/* Reuses the dialog's OptionCard so the selection visual matches
            exactly: same faint border selected/unselected, a neutral filled
            dot + light tint for the active choice — no near-black border. */}
        {VISIBILITY_OPTIONS.map((opt) => (
          <OptionCard
            key={opt.value}
            name="onboarding-visibility"
            checked={visibility === opt.value}
            onSelect={() => setVisibility(opt.value)}
          >
            <div className="min-w-0">
              <div className="text-body font-medium">{opt.title}</div>
              <div className="text-caption text-muted-foreground">{opt.description}</div>
            </div>
          </OptionCard>
        ))}
      </fieldset>

      {agentError && (
        // Light inline error; the Create button right below is the retry.
        <FlowHint tone="error" role="alert">
          {COPY.errors.agentFailed}
        </FlowHint>
      )}

      {computer.connectedClients.length === 0 && (
        // Computer dropped (slept / offline) or resumed here with it not
        // connected — Create is gated on a live client. One line with the
        // "reconnect it" action inline (→ connect-computer), not a separate
        // orphaned link. Auto-clears once the poll sees it reconnect.
        <FlowHint>
          {COPY.createAgent.computerDisconnected.pre}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            style={{ color: "var(--primary)" }}
            onClick={() => goTo(sequence.indexOf("connect-computer"))}
          >
            {COPY.createAgent.computerDisconnected.link}
          </button>
          {COPY.createAgent.computerDisconnected.post}
        </FlowHint>
      )}

      <div className="flex">
        <Button type="button" variant="cta" onClick={handleCreate} disabled={!canCreate}>
          <span>Create agent</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
