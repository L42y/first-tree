import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleCheck, Copy as CopyIcon, FileText } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { listAgents } from "../../../api/agents.js";
import { getContextEnablementHandoff } from "../../../api/context-enablement.js";
import { listMembers } from "../../../api/members.js";
import { getContextTreeSetting } from "../../../api/org-settings.js";
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
 * Progressive member entry. The first screen recommends one standard journey:
 * create a personal First Tree agent and start its first chat. Team-agent and
 * external Context access appear only after the member explicitly continues
 * without their own agent, so alternatives remain discoverable without
 * competing with the product's primary onboarding path.
 */
type GetStartedMode = "recommend" | "continue-without" | "byo-setup";
type ByoContextState = "checking" | "error" | "ready" | "unavailable";

export function StepGetStarted({ defaultMode = "recommend" }: { defaultMode?: GetStartedMode } = {}) {
  const { organizationId, sequence, goNext, goTo, offerTeamAgentStart, computer, teamDisplayName, finishLater } =
    useOnboardingFlow();
  const [mode, setMode] = useState<GetStartedMode>(defaultMode);
  const contextQuery = useQuery({
    queryKey: ["onboarding", "member-byo-readiness", organizationId],
    queryFn: async () => {
      const tree = await getContextTreeSetting(organizationId ?? "");
      return Boolean(tree.repo);
    },
    enabled: !!organizationId && mode !== "recommend",
    // The enable screen is a live authority boundary. Keep checking while it
    // is open so a Team switch or an Admin-side Context Tree change
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

  if (mode === "continue-without") {
    return (
      <PickTeamAgent
        onBack={() => setMode("recommend")}
        canUseTeamAgent={offerTeamAgentStart}
        contextState={contextState}
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
  if (mode === "byo-setup") {
    return <ByoSetup onBack={() => setMode("continue-without")} contextState={contextState} onFinish={finishLater} />;
  }
  return (
    <RecommendedStart
      teamDisplayName={teamDisplayName}
      computerReady={managedComputerReady}
      onOwnAgent={() => {
        if (managedComputerReady) {
          goTo(sequence.indexOf("create-agent"));
          return;
        }
        goNext();
      }}
      onContinueWithout={() => setMode("continue-without")}
    />
  );
}

// ── recommended personal agent ─────────────────────────────────────────

function RecommendedStart({
  teamDisplayName,
  computerReady,
  onOwnAgent,
  onContinueWithout,
}: {
  teamDisplayName: string | null;
  computerReady: boolean;
  onOwnAgent: () => void;
  onContinueWithout: () => void;
}) {
  const g = COPY.getStarted;
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <p
          className="inline-flex items-center self-start text-label font-medium"
          role="status"
          style={{ gap: "var(--sp-2)", margin: 0, color: "var(--fg-2)" }}
        >
          <CircleCheck className="h-4 w-4" style={{ color: "var(--success)" }} aria-hidden="true" />
          <span>{g.joinedTeam(teamDisplayName ?? "your team")}</span>
        </p>
        <StepHeading title={g.recommendedTitle} why={g.recommendedWhy} />
      </div>

      {computerReady ? (
        <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
          {g.computerReady}
        </p>
      ) : (
        <div className="flex flex-wrap items-center text-label" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
          {g.personalSteps.map((step, index) => (
            <span key={step} className="contents">
              {index > 0 ? <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
              <span>{step}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col items-start" style={{ gap: "var(--sp-3)" }}>
        <Button type="button" variant="cta" size="lg" onClick={onOwnAgent}>
          {computerReady ? g.personal.readyCta : g.personal.cta}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onContinueWithout}>
          {g.continueWithout}
        </Button>
      </div>
    </div>
  );
}

// ── BYO: one paste in the member's existing coding agent ───────────────

function ByoSetup({
  onBack,
  contextState,
  onFinish,
}: {
  onBack: () => void;
  contextState: ByoContextState;
  onFinish: () => Promise<void>;
}) {
  const g = COPY.getStarted;
  const { organizationId, teamDisplayName, computer, prepareByoBootstrap } = useOnboardingFlow();
  const { cliCommand, tokenError, retry } = computer;

  useEffect(() => {
    prepareByoBootstrap();
  }, [prepareByoBootstrap]);

  const claudeHandoff = useQuery({
    queryKey: ["onboarding", "member-byo-handoff", organizationId, "claude-code", "onboarding"],
    queryFn: () => getContextEnablementHandoff(organizationId ?? "", "claude-code", "onboarding"),
    enabled: Boolean(organizationId) && contextState === "ready",
  });
  const codexHandoff = useQuery({
    queryKey: ["onboarding", "member-byo-handoff", organizationId, "codex", "onboarding"],
    queryFn: () => getContextEnablementHandoff(organizationId ?? "", "codex", "onboarding"),
    enabled: Boolean(organizationId) && contextState === "ready",
  });
  const handoffReady =
    !claudeHandoff.isFetching &&
    !codexHandoff.isFetching &&
    !claudeHandoff.isError &&
    !codexHandoff.isError &&
    Boolean(claudeHandoff.data) &&
    Boolean(codexHandoff.data);
  const setupPrompt =
    contextState === "ready" && claudeHandoff.data && codexHandoff.data && cliCommand && organizationId
      ? buildByoSetupPrompt({
          organizationId,
          bootstrapCommand: cliCommand,
          handoffs: [claudeHandoff.data, codexHandoff.data],
          intent: "onboarding",
        })
      : null;

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
          {claudeHandoff.isError || codexHandoff.isError ? (
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <FlowHint tone="error" role="alert">
                {g.byoHandoffError}
              </FlowHint>
              <div className="flex">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void claudeHandoff.refetch();
                    void codexHandoff.refetch();
                  }}
                >
                  {g.byoRetryPrompt}
                </Button>
              </div>
            </div>
          ) : (
            <ByoSetupPromptCard
              key={setupPrompt ?? "preparing"}
              provider="Claude Code or Codex"
              team={claudeHandoff.data?.teamDisplayName ?? teamDisplayName ?? "Your team"}
              prompt={setupPrompt}
            />
          )}
          {preparingPrompt ? <StatusRow state="waiting" label={g.byoPreparingPrompt} /> : null}
          {setupPrompt ? (
            <div className="flex">
              <Button type="button" variant="outline" onClick={() => void onFinish()}>
                {g.byoReturnToFirstTree}
              </Button>
            </div>
          ) : null}
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
          data-clarity-mask="true"
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

// ── continue without a personal agent ──────────────────────────────────

function PickTeamAgent({
  onBack,
  canUseTeamAgent,
  contextState,
  onByo,
}: {
  onBack: () => void;
  canUseTeamAgent: boolean;
  contextState: ByoContextState;
  onByo: () => void;
}) {
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
    enabled: canUseTeamAgent,
    staleTime: 30_000,
  });
  const reportedAgentListFailureRef = useRef(false);
  // Owner names for the "Run by X" tag. Member-readable route; cheap and
  // rarely-changing, so no polling.
  const membersQuery = useQuery({
    queryKey: ["members", "team-agent-picker", organizationId],
    queryFn: listMembers,
    enabled: canUseTeamAgent,
    staleTime: 60_000,
  });

  const ownerById = new Map((membersQuery.data ?? []).map((m) => [m.id, m.displayName]));
  // Exclude anything the member manages themselves (defensive — the fork
  // self-skips once they have a personal agent). Humans are already excluded
  // server-side by the `type=agent` filter.
  const candidates = canUseTeamAgent
    ? (agentsQuery.data ?? []).filter((a) => !(memberId && a.managerId === memberId))
    : [];
  const ownerLookupIncomplete =
    canUseTeamAgent &&
    !membersQuery.isPending &&
    !membersQuery.isError &&
    candidates.some((agent) => !agent.managerId || !ownerById.has(agent.managerId));
  const rosterFailed = agentsQuery.isError || membersQuery.isError || ownerLookupIncomplete;

  useEffect(() => {
    if (!rosterFailed || reportedAgentListFailureRef.current) return;
    reportedAgentListFailureRef.current = true;
    reportStepFailure("team_agent_list_failed", { step: "get-started" });
  }, [reportStepFailure, rosterFailed]);

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
        // Team-agent quick start suppresses automatic reopening but deliberately
        // leaves personal-agent onboarding incomplete and resumable.
        stamp: "invitee_skip",
        startChatType: "team-agent-quick-start",
      });
      await completeAndEnterChat(chatId, "get-started", "invitee_skip");
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
      <StepHeading
        title={canUseTeamAgent ? g.pickTitle : g.continueTitle}
        why={canUseTeamAgent ? g.pickWhy : g.continueWhy}
      />
      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}
      {canUseTeamAgent && (agentsQuery.isLoading || membersQuery.isLoading) ? (
        <StatusRow state="waiting" label="Loading team agents…" />
      ) : canUseTeamAgent && rosterFailed ? (
        // A failed roster read is NOT "no team agent": claiming emptiness on a
        // network/server error would be false and unrecoverable. Name the
        // failure and offer a retry.
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint tone="error" role="alert">
            {g.pickError}
          </FlowHint>
          <div className="flex">
            <Button
              type="button"
              onClick={() => {
                reportedAgentListFailureRef.current = false;
                void Promise.all([agentsQuery.refetch(), membersQuery.refetch()]);
              }}
            >
              {g.pickRetry}
            </Button>
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint>{g.pickEmpty}</FlowHint>
          <ContextAccessAlternative contextState={contextState} onSelect={onByo} />
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
          <div className="surface-raised flex flex-col overflow-hidden">
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
          <ContextAccessAlternative contextState={contextState} onSelect={onByo} />
        </div>
      )}
    </div>
  );
}

function ContextAccessAlternative({ contextState, onSelect }: { contextState: ByoContextState; onSelect: () => void }) {
  const g = COPY.getStarted;
  if (contextState === "unavailable") return null;

  return (
    <div
      className="flex flex-col items-start"
      style={{ gap: "var(--sp-1)", borderTop: "var(--hairline) solid var(--border-faint)", paddingTop: "var(--sp-4)" }}
    >
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-label"
        disabled={contextState === "checking"}
        onClick={onSelect}
      >
        {contextState === "checking" ? g.byo.checkingCta : contextState === "error" ? g.byo.retry : g.byo.cta}
        {contextState === "ready" ? <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      </Button>
      <p className="text-caption" style={{ margin: 0, color: "var(--fg-4)" }}>
        {contextState === "error" ? g.byo.error : g.byo.description}
      </p>
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
      className="flex items-start"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-3) var(--sp-4)",
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
          <div className="text-caption break-words" style={{ color: "var(--fg-4)" }}>
            {detail}
          </div>
        ) : null}
        <div className="text-caption break-words" style={{ color: "var(--fg-4)" }}>
          {g.teamAgentExecution(owner)}
        </div>
      </div>
      <Button type="button" onClick={onStart} className="shrink-0">
        {g.startChat}
      </Button>
    </div>
  );
}
