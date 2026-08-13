import { opentagEntryPath, parseOpenTagEntryPath, type RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { createAgent, createAgentFeishuSetupChat, getAgent, startAgentFeishuRegistration } from "../../api/agents.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import {
  feishuBindingQueryKey,
  feishuBindingQueryOptions,
  isFeishuHandoffUsable,
} from "../../features/feishu/binding-view.js";
import { slugify } from "../../utils/agent-naming.js";
import { FlowHint } from "../onboarding/flow-ui.js";
import { OPENTAG_FIRST_TASK_COMPLETE_COPY } from "./copy.js";
import { createOpenTagFirstUseScan, FIRST_USE_POLL_MS } from "./first-use.js";
import {
  classifyOpenTagAgent,
  FEISHU_TOOLS_SLOW_MS,
  OPENTAG_STEPS,
  type OpenTagFirstUse,
  type OpenTagStepId,
  resolveOpenTagStep,
} from "./flow.js";
import { OpenTagShell } from "./opentag-shell.js";
import { isAgentNameConflict, recoverCreatedAgent } from "./recover-created-agent.js";
import { StepChooseAgent } from "./steps/step-choose-agent.js";
import { StepConnectFeishu } from "./steps/step-connect-feishu.js";
import { StepSetUpRuntime } from "./steps/step-set-up-runtime.js";
import { StepUseInFeishu } from "./steps/step-use-in-feishu.js";

/**
 * `/opentag` — the authenticated OpenTag entry.
 *
 * Sign-in already established the Team (solo OAuth mints the personal Team;
 * a returning member acts in the Team they have selected), so this route never
 * creates or names one. It owns three decisions — which Agent, which Computer,
 * which Feishu Bot — and nothing else.
 *
 * The Agent is materialized once, atomically, when both halves of it are
 * known: the Template the member picked and the Computer plus runtime it will
 * run on. Until then the two choices are ordinary local state — nothing is in
 * the database to leave half-finished, and a reload simply re-asks them. After
 * it, the Agent id in the URL plus authoritative reads answer every step, so a
 * reload, a lost response, a wrong Agent, or a deleted Agent all resolve to a
 * defined step instead of a half-remembered one.
 */
/** What the member has chosen before anything is created. */
export type OpenTagDraft = {
  templateId: string;
  templateName: string;
  displayName: string;
};

export function OpenTagPage(): ReactElement | null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const {
    organizationId,
    memberId,
    role,
    user,
    meAuthoritative,
    currentOrgHasPersonalAgent,
    refreshMeStrict,
    markOnboardingCompleted,
  } = useAuth();

  // One parser for the browser route and the OAuth `next`, so a URL this app
  // would never build is not a URL this page will act on. Anything else is
  // replaced with the bare entry rather than driving a read that can only
  // fail.
  const target = parseOpenTagEntryPath(`${location.pathname}${location.search}${location.hash}`);
  const agentUuid = target?.agentUuid ?? null;
  useEffect(() => {
    if (!target) {
      navigate(opentagEntryPath(), { replace: true });
      return;
    }
    // A fragment is ignored, so drop it from the address bar too. This URL is
    // the flow's only progress memory and the thing a member reloads or
    // re-shares, so it should be the one canonical spelling of this entry.
    if (location.hash !== "") navigate(opentagEntryPath(target.agentUuid), { replace: true });
  }, [target, location.hash, navigate]);

  // Remembered across the URL rewrite below, so the member is told why they are
  // back at the start even though the rejected Agent is no longer in the URL.
  const [rejectedAgent, setRejectedAgent] = useState(false);

  const agentQuery = useQuery({
    queryKey: ["agent", agentUuid],
    queryFn: () => getAgent(agentUuid ?? ""),
    enabled: !!agentUuid,
    // A wrong or deleted Agent is answered by the step logic, not by React
    // Query retries that would leave the member on a blank frame.
    retry: false,
  });

  const facts = classifyOpenTagAgent({
    organizationId,
    // `meLoaded` also flips after an initial `/me` transport failure, which
    // would leave this page offering Team-scoped creation against a guessed
    // Team. Only an authoritative snapshot may unlock it.
    meAuthoritative,
    agentUuid,
    memberId,
    role,
    loading: !!agentUuid && agentQuery.isPending,
    // `failed` and `errorStatus` are separate on purpose: a transport error
    // (offline, DNS, CORS) is not an `ApiError` and carries no status, but it
    // is still a failure the member has to be able to retry out of.
    failed: agentQuery.isError,
    errorStatus: agentQuery.error instanceof ApiError ? agentQuery.error.status : null,
    agent: agentQuery.data ?? null,
  });

  // An Agent this flow cannot use has to leave the URL, not just stop being
  // rendered: while it is still there the restart it offers cannot advance,
  // because a fresh draft is only allowed to move once no Agent is targeted.
  useEffect(() => {
    if (facts.state !== "unavailable" || !agentUuid) return;
    setRejectedAgent(true);
    setDraft(null);
    setDraftStage("focus");
    navigate(opentagEntryPath(), { replace: true });
  }, [facts.state, agentUuid, navigate]);
  const agent = facts.state === "resolved" ? (agentQuery.data ?? null) : null;

  // What the member has chosen but not yet created. Plain component state on
  // purpose: nothing here exists server-side, so a reload has nothing to
  // recover and re-asking two questions is cheaper than any draft store.
  const [draft, setDraft] = useState<OpenTagDraft | null>(null);
  const [draftStage, setDraftStage] = useState<"focus" | "runtime">("focus");
  // Set only when a repeated create collided with an Agent this member already
  // manages under the exact handle OpenTag derived. It is offered, never taken
  // automatically — the name is a hint, not proof of what happened.
  const [recoverableAgent, setRecoverableAgent] = useState<{ uuid: string; displayName: string } | null>(null);

  const create = useMutation({
    mutationFn: (args: { draft: OpenTagDraft; clientId: string; runtimeProvider: RuntimeProvider }) => {
      // One call, one transaction: the Agent row, its Computer and runtime, the
      // matching durable config, and the Template adoption all land together or
      // not at all. This is the same organization-scoped create the standalone
      // onboarding flow uses — there is no second protocol for OpenTag.
      //
      // The derived handle also keeps a lost response from silently producing a
      // second Agent: it is unique per Team, so pressing the button again is
      // refused with a name conflict instead of quietly duplicating.
      const name = slugify(args.draft.displayName);
      return createAgent({
        type: "agent",
        displayName: args.draft.displayName,
        ...(name ? { name } : {}),
        // Organization-visible by default: an OpenTag Agent exists to be
        // reachable from Feishu by the team, and hiding it would contradict
        // the handoff this entry promises.
        visibility: "organization",
        templateIds: [args.draft.templateId],
        clientId: args.clientId,
        runtimeProvider: args.runtimeProvider,
        ...(organizationId ? { organizationId } : {}),
      });
    },
    onError: async (error, variables) => {
      setRecoverableAgent(null);
      if (!isAgentNameConflict(error)) return;
      const handle = slugify(variables.draft.displayName);
      if (!handle) return;
      const existing = await recoverCreatedAgent(handle, organizationId);
      if (existing) setRecoverableAgent({ uuid: existing.uuid, displayName: existing.displayName });
    },
    onSuccess: (created) => {
      queryClient.setQueryData(["agent", created.uuid], created);
      // Anchor first, genuinely before anything slower. An active `agents`
      // refetch can take a while, and a reload during that await would leave
      // the browser at the bare entry with the Agent already created.
      goToAgent(created.uuid);
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  // The URL is this route's only durable recovery state, so an Agent goes into
  // it the moment it exists — before anything slower. A reload or a lost tab
  // then still points at that Agent instead of a bare entry that would offer to
  // create another one.
  const goToAgent = (uuid: string): void => {
    // Replace, not push: the pre-Agent URL is no longer a state the member
    // should be able to go back into and create a second Agent from.
    navigate(opentagEntryPath(uuid), { replace: true });
  };

  // Readiness is then healed from that Agent URL. `/me` still says this member
  // has no Agent, and a stale `currentOrgHasPersonalAgent` does not merely
  // misroute them: `/` sends them to `/onboarding`, which freezes its entry
  // decision without re-reading `/me`, and whose create-agent step only skips
  // itself when that same flag is true — so they could be walked into creating
  // a second Agent. Keyed by the URL Agent, so it survives a remount.
  //
  // Only an Agent this member manages personally can move that fact:
  // `hasPersonalAgent` counts Agents whose `managerId` is this member. An admin
  // continuing a teammate's Agent is a legitimate resolved shape — they may
  // manage it and the Feishu write allows it — but the flag stays false however
  // often `/me` is re-read, and nothing needs healing there because `/` is
  // right that this member still has no Agent of their own. Waiting on it would
  // hang that member on the checking state with no way forward.
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const ownsUrlAgent = !!agent && !!memberId && agent.managerId === memberId;
  const readinessSettled = facts.state !== "resolved" || !ownsUrlAgent || currentOrgHasPersonalAgent;
  const healReadiness = useCallback(async (): Promise<void> => {
    setReadinessError(null);
    try {
      await refreshMeStrict();
    } catch {
      setReadinessError("Your agent is ready, but we couldn't refresh your team.");
    }
  }, [refreshMeStrict]);
  useEffect(() => {
    if (readinessSettled) return;
    void healReadiness();
  }, [readinessSettled, healReadiness]);

  const clearRecoveryState = (): void => {
    setRecoverableAgent(null);
    create.reset();
  };

  // The handoff stays closed until readiness is current. Otherwise the member
  // could connect a Bot and finish this surface while `/` still believes they
  // have no Agent — the very gate this boundary exists to keep honest.
  //
  // Keyed on the Agent facts rather than on the resolved step, because the step
  // is now derived from these reads: gating them on the step they produce would
  // close the handoff the moment it reached its own last leg.
  const feishuReady = facts.state === "resolved" && !!agentUuid && readinessSettled;
  const feishuQuery = useQuery({
    ...feishuBindingQueryOptions(agentUuid ?? ""),
    enabled: feishuReady,
  });
  const startFeishu = useMutation({
    mutationFn: () => startAgentFeishuRegistration(agentUuid ?? "", `${agent?.displayName ?? "agent"} · OpenTag`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feishuBindingQueryKey(agentUuid ?? "") }),
  });

  // Real first use is a fact about a Bot that already exists, so there is
  // nothing to ask about until one does — a Bot the member is still confirming
  // in Feishu cannot have carried a message yet. Past that point the binding id
  // is what makes the answer this Agent's and no one else's, so it is part of
  // the key: a re-registered Bot asks the question again rather than serving
  // the previous Bot's answer.
  const binding = feishuQuery.data?.binding ?? null;

  // Committing to Feishu is what licenses this, and the binding is the durable
  // proof of it: nothing is prepared for a member who has not asked for a Bot,
  // and a reload does not have to remember a click because the Bot itself
  // remembers. The call is create-or-reuse server-side, so firing it again on
  // every load, tab, and retry converges on one Task rather than a pile.
  const prepareTools = useMutation({
    mutationFn: (args: { retry: boolean }) => createAgentFeishuSetupChat(agentUuid ?? "", args),
  });
  const prepareToolsMutate = prepareTools.mutate;
  // Ownership, not readability, licenses this. An admin may legitimately open a
  // teammate's Agent here, but their visit is not that member's setup: starting
  // work on somebody else's Computer just by looking at a page is a side effect
  // nobody asked for. The same rule already governs the reads and the stamp
  // below.
  //
  // There also has to be a Computer to prepare. `offline` means none is bound
  // at all, so the Task would be keyed to no machine and reach nobody — the
  // step says so instead, and the fix for it lives on the Agent's own page.
  const preparesTools =
    feishuReady && ownsUrlAgent && !!binding && (binding.cli.state === "missing" || binding.cli.state === "unknown");
  // Asked once per Agent and Computer, not once per page. The Task the server
  // creates is keyed to that exact pair, so an Agent that moves machine while
  // this page is open needs the check on the new one — and a mutation flag that
  // only remembers "we asked something, once" would leave that member waiting
  // for work nobody requested.
  const toolsIdentity = binding ? `${agentUuid ?? ""}:${binding.cli.clientId ?? "unbound"}` : null;
  const [askedToolsFor, setAskedToolsFor] = useState<string | null>(null);
  useEffect(() => {
    if (!preparesTools || !toolsIdentity || prepareTools.isPending) return;
    if (askedToolsFor === toolsIdentity) return;
    setAskedToolsFor(toolsIdentity);
    prepareToolsMutate({ retry: false });
  }, [preparesTools, toolsIdentity, askedToolsFor, prepareTools.isPending, prepareToolsMutate]);

  // The clock starts when the member commits to Feishu, not when the automatic
  // request goes out. Both halves can strand somebody — a Bot that is never
  // confirmed as surely as a Computer that never finishes — and a Computer that
  // was already ready sends no request at all, so timing the request would
  // leave exactly those members with no way out.
  //
  // The threshold is a presentation change, not a deadline, so it is armed once
  // and never disarmed: the Task keeps running either way, and a wait that has
  // already been long does not become short again.
  const committedToFeishu = feishuReady && !!binding;
  const [stepStartedAt, setStepStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!committedToFeishu) return;
    setStepStartedAt((started) => started ?? Date.now());
  }, [committedToFeishu]);
  const [stepSlow, setStepSlow] = useState(false);
  useEffect(() => {
    if (stepStartedAt === null || stepSlow) return;
    const remaining = FEISHU_TOOLS_SLOW_MS - (Date.now() - stepStartedAt);
    if (remaining <= 0) {
      setStepSlow(true);
      return;
    }
    const timer = setTimeout(() => setStepSlow(true), remaining);
    return () => clearTimeout(timer);
  }, [stepStartedAt, stepSlow]);

  // What the step offers, as plain facts rather than a second state machine.
  // A failure belongs to the Agent and Computer it was asked for: once either
  // moves on, the old machine's failed request says nothing about the new one,
  // and a Computer that arrives already prepared never asks again.
  const setupFailed = prepareTools.isError && askedToolsFor === toolsIdentity;
  const botFailed = !!binding && (binding.status === "error" || binding.connectionStatus === "error");
  const hasComputer = !!binding && binding.cli.state !== "offline";
  const toolsReady = binding?.cli.state === "ready";
  // A finished handoff has nothing to recover from, however it got there. Short
  // of that, a failed request, a failed Bot and a missing Computer are all
  // established rather than suspected, so none of them waits for the clock.
  const showRecovery =
    !!binding && !isFeishuHandoffUsable(binding) && (setupFailed || botFailed || !hasComputer || stepSlow);
  // Retrying is scoped to the half it retries. A Bot that failed can put the
  // way out on screen, but it is no reason to ask the Agent to prepare a
  // Computer that is already getting on with it.
  const canRetryTools = hasComputer && !toolsReady && (setupFailed || stepSlow);
  const botBindingId = binding && binding.status !== "provisioning" ? binding.id : null;
  // Ownership, not readability, is what licenses the stamp below.
  //
  // The Bot binding proves which Agent the Task belongs to. It says nothing
  // about which member's onboarding is being finished, and the two genuinely
  // come apart: an admin may continue a teammate's Agent here, and if that
  // admin manages some other Agent the primary invited into its Task, the
  // ordinary watcher projection hands them a membership in that very Task. The
  // read would then succeed, the binding would match exactly, and the stamp
  // would land on the admin's membership because a teammate used a teammate's
  // Agent. Completion means this member owns the setup, so the question is not
  // asked at all unless they do.
  //
  // The member id is in the key for the same reason: a cached answer belongs to
  // whoever it was read for.
  // One scan per (Agent, Bot), reused across polls so its verdict cache
  // survives them; either changing throws the whole thing away. It is not keyed
  // by member because what it remembers — which chat carries which Bot
  // binding — is the same answer whoever asks. Who may act on that answer is
  // decided by the ownership gate and the query key, not here.
  const scanFirstUse = useMemo(
    () => createOpenTagFirstUseScan(agentUuid ?? "", botBindingId ?? ""),
    [agentUuid, botBindingId],
  );
  // Both halves of the handoff gate the search itself, not its answer. An Agent
  // whose Computer cannot call Feishu would receive a first message it can
  // never reply to, and finding that Task would stamp onboarding complete on a
  // handoff that does not work. Gating the read rather than masking its result
  // also means a Task already found stays found: the conversation is a durable
  // fact, and a later capability blip should not walk the member back through a
  // step they finished.
  const firstUseQuery = useQuery({
    queryKey: ["opentag-feishu-first-use", agentUuid, botBindingId, memberId],
    queryFn: ({ signal }) => scanFirstUse(signal),
    enabled: feishuReady && ownsUrlAgent && !!botBindingId && isFeishuHandoffUsable(binding),
    // A failed read must stay "we don't know", never "not used yet" — and never
    // a blank frame. The poll below is the retry.
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "present" ? false : FIRST_USE_POLL_MS),
  });
  // Anything but a landed, successful read is `unknown`: an error here says
  // something about the request, never about whether the member has used their
  // Agent.
  const firstUse: OpenTagFirstUse = firstUseQuery.data ?? { state: "unknown" };
  const firstUseChatId = firstUse.state === "present" ? firstUse.chatId : null;

  // The one write this discovery makes, and only after the Task is a fact. The
  // server stamp is idempotent, so a reload after first use converges on the
  // same membership instead of producing a second onboarding state.
  const complete = useMutation({ mutationFn: () => markOnboardingCompleted() });
  const completePending = complete.isPending;
  const completeSettled = complete.isSuccess;
  const completeFailed = complete.isError;
  const completeMutate = complete.mutate;
  const completeReset = complete.reset;
  useEffect(() => {
    // Ownership is re-checked at the write itself, not only at the read that
    // feeds it: this is the line that changes durable state, and it should not
    // depend on a caller upstream having kept a cached answer honest.
    if (!ownsUrlAgent) return;
    // The handoff is re-checked at the write for the same reason. The scan that
    // produced this Task ran against an earlier read, and a capability that has
    // since gone means the Agent cannot answer the very Task about to finish
    // its setup. Holding here costs a member nothing — the poll behind this
    // keeps the answer current — while stamping would be wrong for good.
    if (!isFeishuHandoffUsable(binding)) return;
    // Once per landed Task: a failure holds until the member retries, so a
    // failing endpoint is not hammered by the first-use poll behind it.
    if (!firstUseChatId || completePending || completeSettled || completeFailed) return;
    completeMutate();
  }, [ownsUrlAgent, binding, firstUseChatId, completePending, completeSettled, completeFailed, completeMutate]);

  // The handoff itself opens the real first-use step. A completed stamp keeps
  // that durable destination stable across a later capability blip in this
  // session; before completion, any loss returns to the repair surface.
  const step = resolveOpenTagStep(facts, isFeishuHandoffUsable(binding) || completeSettled);

  // The draft only describes the pre-creation choices, so an Agent in the URL
  // always supersedes it — including an Agent that turns out to be unusable,
  // where keeping the draft would push the member straight back into the
  // create step and the conflict they just came from.
  const draftStep: OpenTagStepId | null =
    step === "choose-agent" && !agentUuid && draftStage === "runtime" && draft ? "set-up-runtime" : step;
  const computer = useComputerConnection(draftStep === "set-up-runtime", {
    requireExplicitSelectionWhenMultiple: true,
  });

  if (!step && facts.state !== "unreadable" && facts.state !== "team-unreadable") return null;
  // A transient read failure keeps the Agent in the URL — dropping it would
  // restart the flow and leave a second Agent behind — and it is shown inside
  // the step it belongs to, so the guided path never vanishes under the member.
  // A fault renders inside the step it belongs to. Without an authoritative
  // Team nothing has been created yet, so that one belongs at the beginning.
  const shellStep: OpenTagStepId = draftStep ?? (facts.state === "team-unreadable" ? "choose-agent" : "set-up-runtime");

  const completedSteps = OPENTAG_STEPS.slice(0, OPENTAG_STEPS.indexOf(shellStep));
  const stepCopy = step === "use-in-feishu" && firstUseChatId ? OPENTAG_FIRST_TASK_COMPLETE_COPY : undefined;

  return (
    <OpenTagShell activeStep={shellStep} completedSteps={completedSteps} stepCopy={stepCopy}>
      {facts.state === "unreadable" && (
        <OpenTagRecoverableError
          message="We couldn't load your agent. Nothing was lost — it and its setup are still there."
          onRetry={() => void agentQuery.refetch()}
        />
      )}
      {facts.state === "team-unreadable" && (
        <OpenTagRecoverableError
          message="We couldn't load your team. Nothing has been created yet."
          onRetry={() => void refreshMeStrict().catch(() => undefined)}
        />
      )}
      {draftStep === "choose-agent" && (
        <>
          {rejectedAgent && <WrongAgentNotice />}
          <StepChooseAgent
            defaultAgentName={user?.username ? `${user.username} assistant` : "Assistant"}
            initialDraft={draft}
            onContinue={(next) => {
              // A new Template/name decision invalidates anything the previous
              // one produced — including a "Continue with …" candidate that
              // belongs to the old handle.
              clearRecoveryState();
              setDraft(next);
              setDraftStage("runtime");
            }}
          />
        </>
      )}
      {draftStep === "set-up-runtime" && draft && (
        <StepSetUpRuntime
          computer={computer}
          draft={draft}
          pending={create.isPending}
          error={create.error instanceof Error ? create.error.message : null}
          onBack={() => {
            clearRecoveryState();
            setDraftStage("focus");
          }}
          onUseComputer={(clientId, runtimeProvider) => create.mutate({ draft, clientId, runtimeProvider })}
          recovery={
            recoverableAgent
              ? {
                  displayName: recoverableAgent.displayName,
                  pending: create.isPending,
                  onContinue: () => goToAgent(recoverableAgent.uuid),
                }
              : null
          }
        />
      )}
      {step === "connect-feishu" && !readinessSettled && (
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          {readinessError ? (
            <>
              <FlowHint tone="error" role="alert">
                {readinessError}
              </FlowHint>
              <div className="flex">
                <Button type="button" variant="outline" onClick={() => void healReadiness()}>
                  Try again
                </Button>
              </div>
            </>
          ) : (
            <p className="text-caption text-muted-foreground" role="status" style={{ margin: 0 }}>
              Finishing up…
            </p>
          )}
        </div>
      )}
      {feishuReady && step === "connect-feishu" && agent && agentUuid && (
        <StepConnectFeishu
          agentUuid={agentUuid}
          binding={binding}
          loading={feishuQuery.isPending}
          // A failed read is not "no Bot". Offering Connect here could start a
          // second registration for an Agent that already has one.
          readFailed={feishuQuery.isError}
          onRetryRead={() => void feishuQuery.refetch()}
          starting={startFeishu.isPending}
          error={startFeishu.error instanceof Error ? startFeishu.error.message : null}
          onConnect={() => startFeishu.mutate()}
          setupFailed={setupFailed}
          recovery={showRecovery}
          canRetryTools={canRetryTools}
          retrying={prepareTools.isPending}
          // The same idempotent request the automatic path makes: when it never
          // landed this starts the Task, and when it did the Agent is already
          // working on the one Task this retry converges on.
          onRetryTools={() => {
            prepareToolsMutate({ retry: true });
            void feishuQuery.refetch();
          }}
        />
      )}
      {step === "use-in-feishu" && agent && (
        <StepUseInFeishu
          agentDisplayName={agent.displayName}
          chatId={firstUseChatId}
          readFailed={firstUseQuery.isError}
          settled={completeSettled}
          failed={completeFailed}
          onRetry={completeReset}
        />
      )}
    </OpenTagShell>
  );
}

function WrongAgentNotice(): ReactElement {
  return (
    <p
      className="text-label"
      role="status"
      style={{
        margin: "0 0 var(--sp-4)",
        color: "var(--fg-3)",
      }}
    >
      That agent isn't available in this team anymore. Pick what your new agent should do to start again.
    </p>
  );
}

function OpenTagRecoverableError({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <FlowHint tone="error" role="alert">
        {message}
      </FlowHint>
      <div className="flex">
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
