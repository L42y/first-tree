import { opentagEntryPath, parseOpenTagEntryPath, type RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { createAgent, getAgent, startAgentFeishuRegistration, updateAgent } from "../../api/agents.js";
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
 * State lives in exactly two places: the Agent id in the URL, and
 * authoritative server reads of that Agent, its Client binding, and its Feishu
 * binding. There is no step index, no draft, and no completion stamp, so a
 * reload, a lost response, a wrong Agent, or a deleted Agent all resolve to a
 * defined step instead of a half-remembered one.
 */
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
  const agent = facts.state === "resolved" ? (agentQuery.data ?? null) : null;

  // The responsibility the member picked, for the handoff summary only. It is
  // deliberately session-scoped rather than persisted: after a reload the
  // summary shows the Agent alone instead of a remembered claim, because the
  // Agent read is the only fact this entry is allowed to rely on.
  const [chosenTemplateName, setChosenTemplateName] = useState<string | null>(null);
  // Set only when a repeated create collided with an Agent this member already
  // manages under the exact handle OpenTag derived. It is offered, never taken
  // automatically — the name is a hint, not proof of what happened.
  const [recoverableAgent, setRecoverableAgent] = useState<{ uuid: string; displayName: string } | null>(null);

  const create = useMutation({
    mutationFn: (args: { displayName: string; templateId: string; templateName: string }) => {
      // Send the derived handle, exactly like the other creation surfaces do.
      // It is also what keeps a lost create response from silently producing a
      // second Agent: the handle is unique per Team, so pressing Confirm again
      // is refused with a name conflict instead of quietly duplicating.
      const name = slugify(args.displayName);
      return createAgent({
        type: "agent",
        displayName: args.displayName,
        ...(name ? { name } : {}),
        // Organization-visible by default: an OpenTag Agent exists to be
        // reachable from Feishu by the team, and hiding it would contradict
        // the handoff this entry promises.
        visibility: "organization",
        templateIds: [args.templateId],
        ...(organizationId ? { organizationId } : {}),
      });
    },
    onError: async (error, variables) => {
      setRecoverableAgent(null);
      if (!isAgentNameConflict(error)) return;
      const handle = slugify(variables.displayName);
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

  // Runtime detection runs only while the Computer decision is live, so an
  // already-bound Agent never mints a connect code it cannot use.
  const computer = useComputerConnection(step === "set-up-runtime", { requireExplicitSelectionWhenMultiple: true });

  const bind = useMutation({
    // The Agent was created before its Computer was known, so it still carries
    // the service default provider. Commit the provider this Computer actually
    // reports as ready in the same call: without it a Computer that runs
    // anything else is a dead end no retry can clear.
    mutationFn: ({ clientId, runtimeProvider }: { clientId: string; runtimeProvider: RuntimeProvider }) =>
      updateAgent(agentUuid ?? "", { clientId, runtimeProvider }),
    onSuccess: async (updated) => {
      // The bind response is the authoritative Agent, so the step advances off
      // the server's answer rather than an optimistic local flag.
      queryClient.setQueryData(["agent", updated.uuid], updated);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["agent-client-status", updated.uuid] });
      // The account-level onboarding step turns on a connected Computer, so a
      // snapshot taken before this bind would still send the member to
      // `/onboarding` from the workspace root.
      await refreshMe();
    },
  });

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
    step ?? (facts.state === "team-unreadable" ? "choose-agent" : "set-up-runtime");

  const completedSteps = OPENTAG_STEPS.slice(0, OPENTAG_STEPS.indexOf(shellStep));
  const handoff = agent ? { agentDisplayName: agent.displayName, responsibility: chosenTemplateName } : null;

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
      {step === "choose-agent" && (
        <>
          {facts.state === "unavailable" && <WrongAgentNotice />}
          <StepChooseAgent
            defaultAgentName={user?.username ? `${user.username} assistant` : "Assistant"}
            creating={create.isPending}
            error={create.error instanceof Error ? create.error.message : null}
            onCreate={(args) => {
              setChosenTemplateName(args.templateName);
              create.mutate(args);
            }}
            recovery={
              recoverableAgent
                ? {
                    displayName: recoverableAgent.displayName,
                    onContinue: () => {
                      // The recovered Agent already exists, so the readiness
                      // snapshot taken before this flow started is stale.
                      void refreshMe();
                      navigate(opentagEntryPath(recoverableAgent.uuid), { replace: true });
                    },
                  }
                : null
            }
          />
        </>
      )}
      {step === "set-up-runtime" && (
        <StepSetUpRuntime
          computer={computer}
          pending={bind.isPending}
          error={bind.error instanceof Error ? bind.error.message : null}
          onUseComputer={(clientId, runtimeProvider) => bind.mutate({ clientId, runtimeProvider })}
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
