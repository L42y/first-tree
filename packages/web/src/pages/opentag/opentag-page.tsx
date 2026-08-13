import { opentagEntryPath, parseOpenTagEntryPath, type RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { createAgent, getAgent, startAgentFeishuRegistration } from "../../api/agents.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import { feishuBindingQueryKey, feishuBindingQueryOptions } from "../../features/feishu/binding-view.js";
import { slugify } from "../../utils/agent-naming.js";
import { FlowHint } from "../onboarding/flow-ui.js";
import { classifyOpenTagAgent, OPENTAG_STEPS, type OpenTagActiveStepId, resolveOpenTagStep } from "./flow.js";
import { OpenTagShell } from "./opentag-shell.js";
import { isAgentNameConflict, recoverCreatedAgent } from "./recover-created-agent.js";
import { StepChooseAgent } from "./steps/step-choose-agent.js";
import { StepConnectFeishu } from "./steps/step-connect-feishu.js";
import { StepSetUpRuntime } from "./steps/step-set-up-runtime.js";

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
  const { organizationId, memberId, role, user, meAuthoritative, refreshMe } = useAuth();

  // One parser for the browser route and the OAuth `next`, so a URL this app
  // would never build is not a URL this page will act on. Anything else is
  // replaced with the bare entry rather than driving a read that can only
  // fail.
  const target = parseOpenTagEntryPath(`${location.pathname}${location.search}`);
  const agentUuid = target?.agentUuid ?? null;
  useEffect(() => {
    if (!target) navigate(opentagEntryPath(), { replace: true });
  }, [target, navigate]);

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
  const step = resolveOpenTagStep(facts);

  // An Agent this flow cannot use has to leave the URL, not just stop being
  // rendered: while it is still there the restart it offers cannot advance,
  // because a fresh draft is only allowed to move once no Agent is targeted.
  useEffect(() => {
    if (facts.state !== "unavailable" || !agentUuid) return;
    setRejectedAgent(true);
    setDraft(null);
    navigate(opentagEntryPath(), { replace: true });
  }, [facts.state, agentUuid, navigate]);
  const agent = facts.state === "resolved" ? (agentQuery.data ?? null) : null;

  // What the member has chosen but not yet created. Plain component state on
  // purpose: nothing here exists server-side, so a reload has nothing to
  // recover and re-asking two questions is cheaper than any draft store.
  const [draft, setDraft] = useState<OpenTagDraft | null>(null);
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
    onSuccess: async (created) => {
      queryClient.setQueryData(["agent", created.uuid], created);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      // The selected Team now has this member's Agent, which the workspace
      // entry gate reads from `/me`; without this a later visit to the
      // workspace would still be bounced into standalone onboarding.
      await refreshMe();
      // Replace, not push: the pre-Agent URL is no longer a state the member
      // should be able to go back into and create a second Agent from.
      navigate(opentagEntryPath(created.uuid), { replace: true });
    },
  });

  // The draft only describes the pre-creation choices, so an Agent in the URL
  // always supersedes it — including an Agent that turns out to be unusable,
  // where keeping the draft would push the member straight back into the
  // create step and the conflict they just came from.
  const draftStep: OpenTagActiveStepId | null =
    step === "choose-agent" && !agentUuid ? (draft ? "set-up-runtime" : "choose-agent") : step;
  const computer = useComputerConnection(draftStep === "set-up-runtime", {
    requireExplicitSelectionWhenMultiple: true,
  });

  // The recovered Agent was created by the request whose response was lost, so
  // the current `/me` still says this member has no Agent. Refresh before
  // moving, or a fast visit to `/` bounces them into `/onboarding`.
  //
  // This is best-effort by construction: the shared `refreshMe` is `fetchMe`,
  // which is deliberately fail-soft and swallows a failed `/me` read, so this
  // flow cannot observe a failure to report or retry. The cost of a silent
  // miss is one misrouted visit to the workspace root, not lost work, so it
  // does not justify a second, strict readiness path through shared auth.
  const [continuing, setContinuing] = useState(false);
  const continueWithRecovered = async (uuid: string): Promise<void> => {
    setContinuing(true);
    await refreshMe();
    setContinuing(false);
    navigate(opentagEntryPath(uuid), { replace: true });
  };

  const clearRecoveryState = (): void => {
    setRecoverableAgent(null);
    create.reset();
  };

  const feishuQuery = useQuery({
    ...feishuBindingQueryOptions(agentUuid ?? ""),
    enabled: step === "connect-feishu" && !!agentUuid,
  });
  const startFeishu = useMutation({
    mutationFn: () => startAgentFeishuRegistration(agentUuid ?? "", `${agent?.displayName ?? "Agent"} · First Tree`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feishuBindingQueryKey(agentUuid ?? "") }),
  });

  if (!step && facts.state !== "unreadable" && facts.state !== "team-unreadable") return null;
  // A transient read failure keeps the Agent in the URL — dropping it would
  // restart the flow and leave a second Agent behind — and it is shown inside
  // the step it belongs to, so the guided path never vanishes under the member.
  // A fault renders inside the step it belongs to. Without an authoritative
  // Team nothing has been created yet, so that one belongs at the beginning.
  const shellStep: OpenTagActiveStepId =
    draftStep ?? (facts.state === "team-unreadable" ? "choose-agent" : "set-up-runtime");

  const completedSteps = OPENTAG_STEPS.slice(0, OPENTAG_STEPS.indexOf(shellStep));
  // The summary reflects what has been decided so far — the draft before the
  // Agent exists, the Agent itself afterwards.
  const handoff = agent
    ? { agentDisplayName: agent.displayName, responsibility: draft?.templateName ?? null }
    : draft
      ? { agentDisplayName: draft.displayName, responsibility: draft.templateName }
      : null;

  return (
    <OpenTagShell activeStep={shellStep} completedSteps={completedSteps} handoff={handoff}>
      {facts.state === "unreadable" && (
        <OpenTagRecoverableError
          message="We couldn't load your Agent. Nothing was lost — it and its setup are still there."
          onRetry={() => void agentQuery.refetch()}
        />
      )}
      {facts.state === "team-unreadable" && (
        <OpenTagRecoverableError
          message="We couldn't load your team. Nothing has been created yet."
          onRetry={() => void refreshMe()}
        />
      )}
      {draftStep === "choose-agent" && (
        <>
          {rejectedAgent && <WrongAgentNotice />}
          <StepChooseAgent
            defaultAgentName={user?.username ? `${user.username} assistant` : "Assistant"}
            onContinue={(next) => {
              // A new Template/name decision invalidates anything the previous
              // one produced — including a "Continue with …" candidate that
              // belongs to the old handle.
              clearRecoveryState();
              setDraft(next);
            }}
          />
        </>
      )}
      {draftStep === "set-up-runtime" && draft && (
        <StepSetUpRuntime
          computer={computer}
          pending={create.isPending || continuing}
          error={create.error instanceof Error ? create.error.message : null}
          onBack={() => {
            clearRecoveryState();
            setDraft(null);
          }}
          onUseComputer={(clientId, runtimeProvider) => create.mutate({ draft, clientId, runtimeProvider })}
          recovery={
            recoverableAgent
              ? {
                  displayName: recoverableAgent.displayName,
                  pending: continuing || create.isPending,
                  onContinue: () => void continueWithRecovered(recoverableAgent.uuid),
                }
              : null
          }
        />
      )}
      {step === "connect-feishu" && agent && agentUuid && (
        <StepConnectFeishu
          agentDisplayName={agent.displayName}
          agentUuid={agentUuid}
          binding={feishuQuery.data?.binding ?? null}
          loading={feishuQuery.isPending}
          // A failed read is not "no Bot". Offering Connect here could start a
          // second registration for an Agent that already has one.
          readFailed={feishuQuery.isError}
          onRetryRead={() => void feishuQuery.refetch()}
          starting={startFeishu.isPending}
          error={startFeishu.error instanceof Error ? startFeishu.error.message : null}
          onConnect={() => startFeishu.mutate()}
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
        padding: "var(--sp-2_5) var(--sp-3)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        color: "var(--fg-3)",
      }}
    >
      That Agent isn't available in this team anymore. Pick what your new Agent should do to start again.
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
