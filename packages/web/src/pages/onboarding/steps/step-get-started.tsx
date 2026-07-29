import type { Agent, ContextIntegrationProvider } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy as CopyIcon, FileText } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { listAgents } from "../../../api/agents.js";
import { getContextEnablementHandoff } from "../../../api/context-enablement.js";
import { listMembers } from "../../../api/members.js";
import { getContextTreeSetting } from "../../../api/org-settings.js";
import { listTeamResourcesForOrg } from "../../../api/resources.js";
import { Avatar } from "../../../components/avatar.js";
import { Button } from "../../../components/ui/button.js";
import { buildByoSetupPrompt } from "../../../lib/byo-setup-prompt.js";
import { buildTeamAgentStartBootstrap } from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowHint, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";
import { startChatErrorMessage } from "../provision-tree.js";
import { startOnboardingChat } from "../tree-setup-chat.js";

/**
 * Every org-visible, addressable, non-human agent — paged through so the
 * candidate set matches the org-wide readiness bit (`currentOrgHasUsableAgent`),
 * which is an unbounded existence query: the walk runs until the server
 * reports no further page, never treating a fixed page count as exhaustive.
 * `type=agent` filters human mirrors out server-side so they never consume
 * page slots and hide an eligible agent on a later page. A non-advancing
 * (repeated) cursor aborts the walk so a misbehaving server cannot loop the
 * client forever.
 */
async function listAllNonHumanAddressableAgents(): Promise<Agent[]> {
  const out: Agent[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const res = await listAgents({ limit: 100, type: "agent", addressableOnly: true, cursor });
    out.push(...res.items);
    const next = res.nextCursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return out;
}

/**
 * Member work-mode choice. The personal First Tree agent is the recommended
 * path, while two lower-emphasis alternatives remain independently complete:
 * - an existing Team agent opens an install-free First Tree Chat;
 * - BYO gives Claude Code or Codex one self-contained setup prompt that
 *   connects the computer and enables Team Context without creating a First
 *   Tree agent.
 *
 * The Team-agent path reuses the ordinary kickoff pipeline and stamps completion
 * because a personal First Tree agent is optional. BYO completes only after the exact
 * provider/Team handoff is prepared. Team readiness stays read-only here:
 * members never receive Admin setup chores.
 */
type GetStartedMode = "choose" | "pick" | "byo-setup";
type ByoContextState = "checking" | "error" | "ready" | "unavailable";

export function StepGetStarted({ defaultMode = "choose" }: { defaultMode?: GetStartedMode } = {}) {
  const { organizationId, sequence, goNext, goTo, offerTeamAgentStart: offer, computer } = useOnboardingFlow();
  const [mode, setMode] = useState<GetStartedMode>(defaultMode);
  const contextQuery = useQuery({
    queryKey: ["onboarding", "member-byo-readiness", organizationId],
    queryFn: async () => {
      const [tree, resources] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        listTeamResourcesForOrg(organizationId ?? ""),
      ]);
      return (
        Boolean(tree.repo) &&
        resources.some(
          (resource) => resource.type === "repo" && resource.scope === "team" && resource.status === "active",
        )
      );
    },
    enabled: !!organizationId && (mode === "choose" || mode === "byo-setup"),
    // The enable screen is a live authority boundary. Keep checking while it
    // is open so a Team switch or an Admin-side repository/Tree change
    // disables the setup artifact instead of leaving stale handoff data live.
    refetchInterval: (query) => (mode === "byo-setup" || !query.state.data ? 5000 : false),
  });
  const contextReady = contextQuery.data === true;
  const managedComputerReady = Boolean(computer.connectedClient) && computer.okRuntimes.length > 0;
  const contextState: ByoContextState = contextQuery.isPending
    ? "checking"
    : contextQuery.isError
      ? "error"
      : contextReady
        ? "ready"
        : "unavailable";

  if (mode === "pick") {
    return <PickTeamAgent onBack={() => setMode("choose")} />;
  }
  if (mode === "byo-setup") {
    return <ByoSetup onBack={() => setMode("choose")} contextState={contextState} />;
  }
  return (
    <ChooseStart
      hasTeamAgent={offer}
      computerReady={managedComputerReady}
      contextState={contextState}
      onOwnAgent={() => {
        if (managedComputerReady) {
          goTo(sequence.indexOf("create-agent"));
          return;
        }
        goNext();
      }}
      onTeamAgent={() => setMode("pick")}
      onByo={() => {
        if (contextQuery.isError) {
          void contextQuery.refetch();
          return;
        }
        setMode("byo-setup");
      }}
    />
  );
}

// ── choose: recommended personal agent + two alternative paths ─────────

function ChooseStart({
  hasTeamAgent,
  computerReady,
  contextState,
  onOwnAgent,
  onTeamAgent,
  onByo,
}: {
  hasTeamAgent: boolean;
  computerReady: boolean;
  contextState: ByoContextState;
  onOwnAgent: () => void;
  onTeamAgent: () => void;
  onByo: () => void;
}) {
  const g = COPY.getStarted;
  const byoEnabled = contextState === "ready" || contextState === "error";
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={g.chooseTitle} why={g.chooseWhy} />
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <ChoiceCard
          primary
          eyebrow={g.recommended}
          title={g.personal.title}
          description={g.personal.description}
          detail={computerReady ? g.personal.readyDetail : g.personal.detail}
          cta={computerReady ? g.personal.readyCta : g.personal.cta}
          onSelect={onOwnAgent}
        />
        <div className="flex flex-col" style={{ gap: "var(--sp-2_5)", paddingTop: "var(--sp-1)" }}>
          <p className="text-caption font-medium" style={{ margin: 0, color: "var(--fg-4)" }}>
            {g.otherWays}
          </p>
          {hasTeamAgent ? (
            <ChoiceCard
              compact
              title={g.team.title}
              description={g.team.description}
              detail={g.team.detail}
              cta={g.team.cta}
              onSelect={onTeamAgent}
            />
          ) : null}
          <ChoiceCard
            compact
            title={g.byo.title}
            description={
              contextState === "checking"
                ? g.byo.checking
                : contextState === "error"
                  ? g.byo.error
                  : contextState === "unavailable"
                    ? g.byo.unavailable
                    : g.byo.description
            }
            detail={contextState === "ready" ? g.byo.detail : undefined}
            cta={
              contextState === "checking"
                ? g.byo.checkingCta
                : contextState === "error"
                  ? g.byo.retry
                  : contextState === "unavailable"
                    ? g.byo.unavailableCta
                    : g.byo.cta
            }
            onSelect={onByo}
            disabled={!byoEnabled}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A full-card action (not an OptionCard: there is no radio state — clicking
 * IS the decision). The primary card carries the stronger border so "set up
 * my own agent" reads as the default; the quick start is a parallel choice,
 * not an escape hatch.
 */
function ChoiceCard({
  eyebrow,
  title,
  description,
  detail,
  cta,
  onSelect,
  primary = false,
  compact = false,
  disabled = false,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  detail?: string;
  cta: string;
  onSelect: () => void;
  primary?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="text-left transition-colors enabled:hover:bg-accent/50"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1)",
        padding: compact ? "var(--sp-3) var(--sp-4)" : "var(--sp-5)",
        borderRadius: "var(--radius-input)",
        border: primary ? "var(--hairline) solid var(--fg)" : "var(--hairline) solid var(--border)",
        background: primary ? "var(--bg-raised)" : "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {eyebrow ? (
        <span className="text-eyebrow uppercase" style={{ color: "var(--fg-3)" }}>
          {eyebrow}
        </span>
      ) : null}
      <span className="text-body font-semibold" style={{ color: "var(--fg)" }}>
        {title}
      </span>
      <span className="text-label" style={{ color: "var(--fg-3)" }}>
        {description}
      </span>
      {detail ? (
        <span className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
          {detail}
        </span>
      ) : null}
      <span
        className="text-label font-medium inline-flex items-center"
        style={{ gap: "var(--sp-1)", color: "var(--fg)", marginTop: "var(--sp-2)" }}
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

// ── BYO: one paste in the member's existing coding agent ───────────────

const BYO_PROVIDERS: Array<{ id: ContextIntegrationProvider; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

function providerLabel(provider: ContextIntegrationProvider): string {
  return BYO_PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

function ByoSetup({ onBack, contextState }: { onBack: () => void; contextState: ByoContextState }) {
  const g = COPY.getStarted;
  const navigate = useNavigate();
  const { organizationId, teamDisplayName, onboardingCompletedAt, refreshOnboarding, computer } = useOnboardingFlow();
  const { cliCommand, tokenError, retry } = computer;
  const [provider, setProvider] = useState<ContextIntegrationProvider>("claude-code");

  const handoff = useQuery({
    queryKey: ["onboarding", "member-byo-handoff", organizationId, provider, "onboarding"],
    queryFn: () => getContextEnablementHandoff(organizationId ?? "", provider, "onboarding"),
    enabled: Boolean(organizationId) && contextState === "ready",
  });
  const handoffReady = !handoff.isFetching && !handoff.isError && Boolean(handoff.data);
  const setupPrompt =
    contextState === "ready" && handoff.data && cliCommand && organizationId
      ? buildByoSetupPrompt({
          organizationId,
          bootstrapCommand: cliCommand,
          handoffs: [handoff.data],
          intent: "onboarding",
        })
      : null;

  useEffect(() => {
    if (!setupPrompt || onboardingCompletedAt) return;
    let active = true;
    const refresh = (): void => {
      void refreshOnboarding().catch(() => undefined);
    };
    refresh();
    const handle = window.setInterval(() => {
      if (active) refresh();
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(handle);
    };
  }, [onboardingCompletedAt, refreshOnboarding, setupPrompt]);

  if (onboardingCompletedAt) {
    return <ByoCompletion onContinue={() => navigate("/")} />;
  }

  const preparingPrompt = handoffReady && !tokenError && !setupPrompt;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <BackToChoices onBack={onBack} />
      <StepHeading title={g.byoSetupTitle} why={g.byoSetupWhy} />
      <FlowHint>{g.byoBoundary}</FlowHint>
      {contextState === "checking" ? (
        <StatusRow state="waiting" label="Checking Team Context…" />
      ) : contextState === "error" ? (
        <FlowHint tone="error" role="alert">
          Couldn't check Team Context just now. Go back and try again.
        </FlowHint>
      ) : contextState === "unavailable" ? (
        <FlowHint role="status">{g.byoUnavailable}</FlowHint>
      ) : tokenError ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <FlowHint tone="error" role="alert">
            {COPY.connectComputer.tokenErrorTitle}
          </FlowHint>
          <div className="flex">
            <Button type="button" variant="outline" onClick={retry}>
              {COPY.connectComputer.retry}
            </Button>
          </div>
        </div>
      ) : organizationId ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
              {g.byoProviderLabel}
            </p>
            <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
              {BYO_PROVIDERS.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={provider === item.id ? "default" : "outline"}
                  aria-pressed={provider === item.id}
                  onClick={() => setProvider(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
          {handoff.isError ? (
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <FlowHint tone="error" role="alert">
                {g.byoHandoffError}
              </FlowHint>
              <div className="flex">
                <Button type="button" variant="outline" onClick={() => void handoff.refetch()}>
                  {g.byoRetryPrompt}
                </Button>
              </div>
            </div>
          ) : (
            <ByoSetupPromptCard
              key={`${provider}:${setupPrompt ?? "preparing"}`}
              provider={providerLabel(provider)}
              team={handoff.data?.teamDisplayName ?? teamDisplayName ?? "Your team"}
              prompt={setupPrompt}
            />
          )}
          {provider === "codex" ? <FlowHint role="status">{g.byoCodexTrust}</FlowHint> : null}
          {preparingPrompt ? <StatusRow state="waiting" label={g.byoPreparingPrompt} /> : null}
        </div>
      ) : (
        <StatusRow state="waiting" label="Preparing your Team Context…" />
      )}
    </div>
  );
}

/**
 * A human-readable task artifact for the member's existing coding agent.
 * The default view explains the outcome; the generated prompt remains fully
 * inspectable on demand and is copied byte-for-byte without making plumbing
 * look like a Terminal step.
 */
function ByoSetupPromptCard({ provider, team, prompt }: { provider: string; team: string; prompt: string | null }) {
  const g = COPY.getStarted;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copied = copyState === "copied";

  const handleCopy = async (): Promise<void> => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="surface-raised flex flex-col" style={{ gap: "var(--sp-3)", padding: "var(--sp-4)" }}>
      <div className="flex flex-wrap items-start justify-between" style={{ gap: "var(--sp-3)" }}>
        <div className="flex items-center" style={{ gap: "var(--sp-3)", minWidth: 0 }}>
          <span
            className="inline-flex items-center justify-center"
            aria-hidden="true"
            style={{
              width: "var(--sp-8)",
              height: "var(--sp-8)",
              flexShrink: 0,
              borderRadius: "var(--radius-input)",
              background: "var(--bg-sunken)",
              color: "var(--fg-2)",
            }}
          >
            <FileText className="h-4 w-4" />
          </span>
          <div className="flex flex-col" style={{ gap: "var(--sp-0_5)", minWidth: 0 }}>
            <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
              {g.byoPromptTitle}
            </p>
            <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
              {g.byoPromptMeta(provider, team)}
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={() => void handleCopy()} disabled={!prompt}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          {copied ? "Copied" : prompt ? g.byoCopyPrompt : g.byoPreparingPrompt}
        </Button>
      </div>

      <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
        {g.byoPromptSummary}
      </p>

      {prompt ? (
        <details
          className="group"
          style={{
            borderTop: "var(--hairline) solid var(--border-faint)",
            paddingTop: "var(--sp-3)",
          }}
        >
          <summary
            className="text-caption font-medium cursor-pointer list-none flex items-center justify-between"
            style={{ color: "var(--fg-3)" }}
          >
            <span>{g.byoViewPrompt}</span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <pre
            className="mono text-label surface-sunken"
            style={{
              margin: "var(--sp-3) 0 0",
              padding: "var(--sp-3)",
              maxHeight: "var(--sp-75)",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "var(--fg-2)",
            }}
          >
            {prompt}
          </pre>
        </details>
      ) : null}

      {copied ? (
        <p className="text-label" role="status" aria-live="polite" style={{ margin: 0, color: "var(--fg-3)" }}>
          {g.byoPasteToContinue(provider)}
        </p>
      ) : copyState === "failed" ? (
        <p className="text-label" role="alert" style={{ margin: 0, color: "var(--state-needs-you)" }}>
          {g.byoCopyFailed}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Completed BYO state. Kept as a small reusable production component so the
 * DEV onboarding gallery can show the real completion page directly instead
 * of requiring reviewers to run the handoff command and mutate preview state.
 */
export function ByoCompletion({ onContinue = () => undefined }: { onContinue?: () => void } = {}) {
  const g = COPY.getStarted;
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <div
        className="inline-flex items-center justify-center"
        aria-hidden="true"
        style={{
          width: "var(--sp-10)",
          height: "var(--sp-10)",
          borderRadius: "var(--radius-full)",
          background: "var(--color-success-soft)",
          color: "var(--success)",
        }}
      >
        <Check className="h-5 w-5" />
      </div>
      <StepHeading title={g.byoCompleteTitle} why={g.byoCompleteWhy} />
      <FlowHint role="status">{g.byoCompleteNote}</FlowHint>
      <div className="flex">
        <Button type="button" onClick={onContinue}>
          {g.byoGoToFirstTree}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function BackToChoices({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex">
      <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>{COPY.getStarted.pickBack}</span>
      </Button>
    </div>
  );
}

// ── Workspace: choose a Team agent and start the kickoff chat ──────────

function PickTeamAgent({ onBack }: { onBack: () => void }) {
  const g = COPY.getStarted;
  const { organizationId, memberId, completeAndEnterChat, reportStepFailure } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  // The readiness bit (`currentOrgHasUsableAgent`) is org-wide, so the
  // candidate set must be too — a single 100-row first page filtered for humans
  // afterward can miss an eligible agent on a later page and render "none"
  // while the fork is offered. Page through every org-visible non-human
  // addressable agent so coverage matches readiness.
  const agentsQuery = useQuery({
    queryKey: ["agents", "team-agent-picker", organizationId],
    queryFn: () => listAllNonHumanAddressableAgents(),
    staleTime: 30_000,
  });
  const reportedAgentListFailureRef = useRef(false);
  useEffect(() => {
    if (!agentsQuery.isError || reportedAgentListFailureRef.current) return;
    reportedAgentListFailureRef.current = true;
    reportStepFailure("team_agent_list_failed", { step: "get-started" });
  }, [agentsQuery.isError, reportStepFailure]);
  // Owner names for the "Run by X" tag. Member-readable route; cheap and
  // rarely-changing, so no polling.
  const membersQuery = useQuery({
    queryKey: ["members", "team-agent-picker", organizationId],
    queryFn: listMembers,
    staleTime: 60_000,
  });

  const ownerById = new Map((membersQuery.data ?? []).map((m) => [m.id, m.displayName]));
  // Exclude anything the member manages themselves (defensive — the fork
  // self-skips once they have a personal agent). Humans are already excluded
  // server-side by the `type=agent` filter.
  const candidates = (agentsQuery.data ?? []).filter((a) => !(memberId && a.managerId === memberId));

  const handleStart = async (agent: Agent): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      const chatId = await startOnboardingChat({
        agent,
        bootstrap: buildTeamAgentStartBootstrap(agent.displayName),
        organizationId,
        topic: "Get settled on First Tree",
        treeBindingPlan: "none",
        joinPath: "invite",
        // Choosing an existing Team agent is a complete First Tree path. A
        // personal First Tree agent remains optional.
        stamp: "completed",
        startChatType: "team-agent-quick-start",
      });
      await completeAndEnterChat(chatId, "get-started");
    } catch (err) {
      setError(startChatErrorMessage(err, COPY.errors.chatFailed));
      setPhase("idle");
      reportStepFailure("start_chat_failed", { step: "get-started" });
    }
  };

  if (phase === "starting") return <WorkingState label={COPY.startChat.starting} />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <BackToChoices onBack={onBack} />
      <StepHeading title={g.pickTitle} why={g.pickWhy} />
      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}
      {agentsQuery.isLoading ? (
        <StatusRow state="waiting" label="Loading team agents…" />
      ) : agentsQuery.isError ? (
        // A failed roster read is NOT "no team agent": claiming emptiness on a
        // network/server error would be false and unrecoverable. Name the
        // failure and offer a retry.
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint tone="error" role="alert">
            {g.pickError}
          </FlowHint>
          <div className="flex">
            <Button type="button" onClick={() => void agentsQuery.refetch()}>
              {g.pickRetry}
            </Button>
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint>{g.pickEmpty}</FlowHint>
          <div className="flex">
            <Button type="button" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              <span>{g.pickBack}</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {candidates.map((a, i) => (
            <AgentRow
              key={a.uuid}
              agent={a}
              owner={a.managerId ? (ownerById.get(a.managerId) ?? null) : null}
              first={i === 0}
              onStart={() => void handleStart(a)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  owner,
  first,
  onStart,
}: {
  agent: Agent;
  owner: string | null;
  first: boolean;
  onStart: () => void;
}) {
  const g = COPY.getStarted;
  const detail: ReactNode = [agent.name ? `@${agent.name}` : null, owner ? g.runBy(owner) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-3) 0",
        borderTop: first ? "none" : "var(--hairline) solid var(--border)",
      }}
    >
      <Avatar
        name={agent.displayName}
        src={agent.avatarImageUrl}
        colorToken={agent.avatarColorToken}
        seed={agent.uuid}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium truncate" style={{ color: "var(--fg)" }}>
          {agent.displayName}
        </div>
        {detail ? (
          <div className="text-caption truncate" style={{ color: "var(--fg-4)" }}>
            {detail}
          </div>
        ) : null}
      </div>
      <Button type="button" onClick={onStart} className="shrink-0">
        {g.startChat}
      </Button>
    </div>
  );
}
