import {
  type CapabilityEntry,
  enabledOkRuntimeProviders,
  enabledRuntimeProviders,
  hasCurrentFeishuRequiredScopes,
  opentagEntryPath,
  parseOpenTagEntryPath,
  type RuntimeAuthProvider,
  type RuntimeProvider,
  runtimeProviderComputerSetupCommand,
  runtimeProviderInProductAuthTarget,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { startRuntimeAuth } from "../../api/activity.js";
import {
  completeAgentFeishuOnboarding,
  createAgent,
  createAgentFeishuSetupChat,
  getAgent,
  startAgentFeishuRegistration,
} from "../../api/agents.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import {
  feishuBindingQueryKey,
  feishuBindingQueryOptions,
  isFeishuBotReachable,
  isFeishuHandoffUsable,
} from "../../features/feishu/binding-view.js";
import { slugify } from "../../utils/agent-naming.js";
import { hasUpdateProblem } from "../clients/derive-status.js";
import {
  classifyOpenTagAgent,
  deriveOpenTagRuntimeState,
  resolveOpenTagPageState,
  runtimeHasLivePendingAuth,
  runtimeIsReady,
} from "./flow.js";
import { OpenTagShell } from "./opentag-shell.js";
import { OpenTagView, type RuntimeChoice } from "./opentag-view.js";
import { isAgentNameConflict, recoverCreatedAgent } from "./recover-created-agent.js";

const FEISHU_RECOVERY_DELAY_MS = 90_000;
const AUTH_POLL_MS = 3_000;
const AUTH_STARTING_LATCH_MS = 30_000;

/**
 * `/opentag` is one conditional page. Before creation it watches one Computer
 * and one executable local Agent. The sole durable click creates the ordinary,
 * organization-visible Agent. The Agent URL then anchors all recovery while
 * Feishu registration, tool preparation, and completion converge automatically.
 */
export function OpenTagPage(): ReactElement | null {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {
    organizationId,
    memberId,
    role,
    meAuthoritative,
    currentOrgHasPersonalAgent,
    refreshMeStrict,
    applyOnboardingStamp,
  } = useAuth();

  const target = parseOpenTagEntryPath(`${location.pathname}${location.search}${location.hash}`);
  const agentUuid = target?.agentUuid ?? null;
  useEffect(() => {
    if (!target) {
      navigate(opentagEntryPath(), { replace: true });
      return;
    }
    if (location.hash !== "") navigate(opentagEntryPath(target.agentUuid), { replace: true });
  }, [target, location.hash, navigate]);

  const agentQuery = useQuery({
    queryKey: ["agent", agentUuid],
    queryFn: () => getAgent(agentUuid ?? ""),
    enabled: !!agentUuid,
    retry: false,
  });
  const facts = classifyOpenTagAgent({
    organizationId,
    meAuthoritative,
    memberId,
    role,
    agentUuid,
    loading: !!agentUuid && agentQuery.isPending,
    failed: agentQuery.isError,
    errorStatus: agentQuery.error instanceof ApiError ? agentQuery.error.status : null,
    agent: agentQuery.data ?? null,
  });
  const agent = facts.state === "resolved" ? (agentQuery.data ?? null) : null;

  useEffect(() => {
    if (facts.state !== "unavailable" || !agentUuid) return;
    navigate(opentagEntryPath(), { replace: true });
  }, [facts.state, agentUuid, navigate]);

  const computer = useComputerConnection(facts.state === "none" || facts.state === "resolved");
  const [displayName, setDisplayName] = useState("OpenTag");
  const [editingName, setEditingName] = useState(false);
  const [selectedLocalAgent, setSelectedLocalAgent] = useState<RuntimeProvider | null>(null);
  const priorSelectedClient = useRef<string | null>(null);
  useEffect(() => {
    if (priorSelectedClient.current !== computer.selectedClientId) {
      priorSelectedClient.current = computer.selectedClientId;
      setSelectedLocalAgent(null);
    }
  }, [computer.selectedClientId]);

  const selectedComputerCapabilities = computer.capabilities ?? computer.connectedClient?.capabilities ?? null;
  const runtimeCandidates = useMemo(() => {
    const reported = enabledRuntimeProviders().filter(
      (provider) => selectedComputerCapabilities?.[provider] || computer.okRuntimes.includes(provider),
    );
    return reported.length > 0 ? reported : enabledRuntimeProviders();
  }, [selectedComputerCapabilities, computer.okRuntimes]);
  const readyRuntimeProviders = useMemo(
    () =>
      selectedComputerCapabilities
        ? enabledOkRuntimeProviders(selectedComputerCapabilities).filter((provider) =>
            runtimeIsReady(selectedComputerCapabilities[provider]),
          )
        : [],
    [selectedComputerCapabilities],
  );
  const selectedRuntime =
    selectedLocalAgent && runtimeCandidates.includes(selectedLocalAgent)
      ? selectedLocalAgent
      : (readyRuntimeProviders[0] ?? runtimeCandidates[0] ?? null);
  const preCreateRuntimeState = deriveOpenTagRuntimeState({
    capabilitiesLoaded: computer.capabilitiesLoaded,
    provider: selectedRuntime,
    entry: selectedRuntime ? selectedComputerCapabilities?.[selectedRuntime] : null,
  });
  const readyRuntimeSet = new Set(readyRuntimeProviders);
  const runtimeChoices: RuntimeChoice[] = [
    ...readyRuntimeProviders,
    ...runtimeCandidates.filter((provider) => !readyRuntimeSet.has(provider)),
  ].map((provider) => ({
    provider,
    ready: runtimeIsReady(selectedComputerCapabilities?.[provider]),
    status: runtimeStatusCopy(selectedComputerCapabilities?.[provider]),
  }));

  const selectedComputer = computer.connectedClients.find((client) => client.id === computer.selectedClientId) ?? null;
  const updateCommand =
    selectedComputer && hasUpdateProblem(selectedComputer) ? `${selectedComputer.binName} upgrade` : null;
  const runtimeReady = preCreateRuntimeState.kind === "ready" && !updateCommand;

  const [recoverableAgent, setRecoverableAgent] = useState<{ uuid: string; displayName: string } | null>(null);
  const create = useMutation({
    mutationFn: ({ clientId, runtimeProvider }: { clientId: string; runtimeProvider: RuntimeProvider }) => {
      const finalDisplayName = displayName.trim();
      const name = slugify(finalDisplayName);
      return createAgent({
        type: "agent",
        displayName: finalDisplayName,
        ...(name ? { name } : {}),
        visibility: "organization",
        clientId,
        runtimeProvider,
        ...(organizationId ? { organizationId } : {}),
      });
    },
    onError: async (error) => {
      setRecoverableAgent(null);
      if (!isAgentNameConflict(error)) return;
      const handle = slugify(displayName.trim());
      if (!handle) return;
      const existing = await recoverCreatedAgent(handle, organizationId);
      if (existing) setRecoverableAgent({ uuid: existing.uuid, displayName: existing.displayName });
    },
    onSuccess: (created) => {
      queryClient.setQueryData(["agent", created.uuid], created);
      navigate(opentagEntryPath(created.uuid), { replace: true });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const ownsUrlAgent = !!agent && !!memberId && agent.managerId === memberId;
  const readinessSettled = facts.state !== "resolved" || !ownsUrlAgent || currentOrgHasPersonalAgent;
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const healReadiness = useCallback(async (): Promise<void> => {
    setReadinessError(null);
    try {
      await refreshMeStrict();
    } catch {
      setReadinessError("Your agent is safe, but we couldn’t refresh your Team. Try again.");
    }
  }, [refreshMeStrict]);
  useEffect(() => {
    if (!readinessSettled) void healReadiness();
  }, [readinessSettled, healReadiness]);

  const feishuEnabled = facts.state === "resolved" && !!agentUuid && readinessSettled;
  const feishuQuery = useQuery({
    ...feishuBindingQueryOptions(agentUuid ?? ""),
    enabled: feishuEnabled,
  });
  const binding = feishuQuery.data?.binding ?? null;
  const bindingNeedsRegistration =
    !binding ||
    binding.status === "error" ||
    (isFeishuBotReachable(binding) && !hasCurrentFeishuRequiredScopes(binding.grantedScopes));
  const [registrationRequestedFor, setRegistrationRequestedFor] = useState<string | null>(null);
  const startFeishu = useMutation({
    mutationFn: () => startAgentFeishuRegistration(agentUuid ?? "", agent?.displayName ?? displayName),
    onSuccess: (result) => {
      queryClient.setQueryData(feishuBindingQueryKey(agentUuid ?? ""), { binding: result.binding });
      void queryClient.invalidateQueries({ queryKey: feishuBindingQueryKey(agentUuid ?? "") });
    },
  });
  const startFeishuMutate = startFeishu.mutate;
  useEffect(() => {
    if (
      !feishuEnabled ||
      !ownsUrlAgent ||
      !agentUuid ||
      !feishuQuery.isSuccess ||
      !bindingNeedsRegistration ||
      startFeishu.isPending
    ) {
      return;
    }
    if (registrationRequestedFor === agentUuid) return;
    setRegistrationRequestedFor(agentUuid);
    startFeishuMutate();
  }, [
    feishuEnabled,
    ownsUrlAgent,
    agentUuid,
    feishuQuery.isSuccess,
    bindingNeedsRegistration,
    startFeishu.isPending,
    registrationRequestedFor,
    startFeishuMutate,
  ]);

  const prepareTools = useMutation({
    mutationFn: ({ retry }: { retry: boolean }) => createAgentFeishuSetupChat(agentUuid ?? "", { retry }),
  });
  const prepareToolsMutate = prepareTools.mutate;
  const shouldPrepareTools =
    feishuEnabled && ownsUrlAgent && !!binding && (binding.cli.state === "missing" || binding.cli.state === "unknown");
  const toolsIdentity = binding ? `${agentUuid ?? ""}:${binding.cli.clientId ?? "unbound"}` : null;
  const [askedToolsFor, setAskedToolsFor] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldPrepareTools || !toolsIdentity || prepareTools.isPending || askedToolsFor === toolsIdentity) return;
    setAskedToolsFor(toolsIdentity);
    prepareToolsMutate({ retry: false });
  }, [shouldPrepareTools, toolsIdentity, prepareTools.isPending, askedToolsFor, prepareToolsMutate]);

  const complete = useMutation({
    mutationFn: (target: { agentUuid: string; memberId: string; organizationId: string }) =>
      completeAgentFeishuOnboarding(target.agentUuid),
    onSuccess: ({ completedAt }, target) => {
      const projected = applyOnboardingStamp("completed", completedAt, {
        id: target.memberId,
        organizationId: target.organizationId,
      });
      if (!projected) void refreshMeStrict().catch(() => undefined);
    },
  });
  const completeMutate = complete.mutate;
  const handoffUsable = isFeishuHandoffUsable(binding);
  useEffect(() => {
    if (
      !ownsUrlAgent ||
      !agentUuid ||
      !memberId ||
      !organizationId ||
      !handoffUsable ||
      complete.isPending ||
      complete.isSuccess ||
      complete.isError
    ) {
      return;
    }
    completeMutate({ agentUuid, memberId, organizationId });
  }, [
    ownsUrlAgent,
    agentUuid,
    memberId,
    organizationId,
    handoffUsable,
    complete.isPending,
    complete.isSuccess,
    complete.isError,
    completeMutate,
  ]);
  const handoffComplete = handoffUsable && (!ownsUrlAgent || complete.isSuccess);
  const hasRegistrationQr = binding?.status === "provisioning" && !!binding.registrationUrl;
  const recoveryClockActive = !!binding && !handoffUsable && !hasRegistrationQr;
  const [handoffStartedAt, setHandoffStartedAt] = useState<number | null>(null);
  const [handoffSlow, setHandoffSlow] = useState(false);
  useEffect(() => {
    if (!recoveryClockActive) {
      setHandoffStartedAt(null);
      setHandoffSlow(false);
      return;
    }
    setHandoffStartedAt((started) => started ?? Date.now());
  }, [recoveryClockActive]);
  useEffect(() => {
    if (handoffStartedAt === null || handoffSlow) return;
    const remaining = FEISHU_RECOVERY_DELAY_MS - (Date.now() - handoffStartedAt);
    if (remaining <= 0) {
      setHandoffSlow(true);
      return;
    }
    const timer = window.setTimeout(() => setHandoffSlow(true), remaining);
    return () => window.clearTimeout(timer);
  }, [handoffStartedAt, handoffSlow]);

  const authAttemptKey =
    computer.selectedClientId && selectedRuntime ? `${computer.selectedClientId}:${selectedRuntime}` : null;
  const selectedRuntimeEntry = selectedRuntime ? selectedComputerCapabilities?.[selectedRuntime] : null;
  const pendingRuntimeAuth = runtimeHasLivePendingAuth(selectedRuntimeEntry);
  const [startingAuth, setStartingAuth] = useState<{ key: string; startedAt: number } | null>(null);
  const lastAuthFailureAt = selectedRuntimeEntry?.lastAuthError
    ? Date.parse(selectedRuntimeEntry.lastAuthError.at)
    : Number.NaN;
  const authFailedSinceStart =
    !!startingAuth && Number.isFinite(lastAuthFailureAt) && lastAuthFailureAt >= startingAuth.startedAt;
  const authStarting =
    !!startingAuth &&
    startingAuth.key === authAttemptKey &&
    !pendingRuntimeAuth &&
    !authFailedSinceStart &&
    Date.now() - startingAuth.startedAt < AUTH_STARTING_LATCH_MS;
  useEffect(() => {
    if (!startingAuth) return;
    if (startingAuth.key !== authAttemptKey || pendingRuntimeAuth || authFailedSinceStart) {
      setStartingAuth(null);
      return;
    }
    const poll = window.setInterval(() => {
      computer.refreshCapabilities?.();
      setStartingAuth((current) =>
        current && Date.now() - current.startedAt < AUTH_STARTING_LATCH_MS ? current : null,
      );
    }, AUTH_POLL_MS);
    return () => window.clearInterval(poll);
  }, [startingAuth, authAttemptKey, pendingRuntimeAuth, authFailedSinceStart, computer.refreshCapabilities]);

  const signIn = useMutation({
    mutationFn: ({ clientId, provider }: { clientId: string; provider: RuntimeAuthProvider }) =>
      startRuntimeAuth(clientId, { provider }),
    onSuccess: (_result, target) => {
      setStartingAuth({ key: `${target.clientId}:${target.provider}`, startedAt: Date.now() });
    },
    onError: () => setStartingAuth(null),
    onSettled: () => {
      computer.refreshCapabilities?.();
    },
  });

  if (facts.state === "loading") return null;

  const boundComputer = agent
    ? (computer.connectedClients.find((client) => client.id === agent.clientId) ?? null)
    : null;
  const viewClients = agent ? (boundComputer ? [boundComputer] : []) : computer.connectedClients;
  const viewSelectedClientId = agent?.clientId ?? computer.selectedClientId;
  const viewSelectedRuntime = agent?.runtimeProvider ?? selectedRuntime;
  const boundRuntimeEntry = agent?.runtimeProvider ? boundComputer?.capabilities[agent.runtimeProvider] : null;
  const viewRuntimeState = agent
    ? deriveOpenTagRuntimeState({
        capabilitiesLoaded: !!boundComputer && Object.keys(boundComputer.capabilities).length > 0,
        provider: agent.runtimeProvider,
        entry: boundRuntimeEntry,
      })
    : preCreateRuntimeState;
  const viewRuntimeChoices = agent
    ? [
        {
          provider: agent.runtimeProvider,
          ready: runtimeIsReady(boundRuntimeEntry),
          status: runtimeStatusCopy(boundRuntimeEntry),
        },
      ]
    : runtimeChoices;

  const pageState = resolveOpenTagPageState({
    hasCreatedAgent: !!agent,
    hasComputer: !!computer.selectedClientId,
    runtimeReady,
    handoffReady: handoffComplete,
  });
  const visibleDisplayName = agent?.displayName ?? displayName;
  const identityState = pageState === "ready" ? "ready" : agent ? "created" : "editable";

  const ownershipBlocksRegistration =
    feishuEnabled && !ownsUrlAgent && feishuQuery.isSuccess && bindingNeedsRegistration;
  const feishuError =
    readinessError ??
    (ownershipBlocksRegistration ? "Only this agent’s owner can finish Feishu setup." : null) ??
    (bindingNeedsRegistration && startFeishu.error instanceof Error ? startFeishu.error.message : null) ??
    (binding?.status === "error" ? (binding.lastErrorMessage ?? "Feishu registration could not finish.") : null) ??
    (binding?.connectionStatus === "error"
      ? (binding.lastErrorMessage ?? "The Feishu Bot connection could not finish.")
      : null) ??
    (binding?.cli.state === "offline" ? "Reconnect the Computer that owns this agent, then try again." : null) ??
    (binding && binding.cli.state !== "ready" && prepareTools.error instanceof Error
      ? prepareTools.error.message
      : null) ??
    (handoffUsable && complete.error instanceof Error ? complete.error.message : null) ??
    (!binding && feishuQuery.error instanceof Error ? feishuQuery.error.message : null) ??
    (handoffSlow ? "Setup is taking longer than expected. Try again to resume it." : null);

  const retryFeishu = (): void => {
    if (!ownsUrlAgent) {
      void feishuQuery.refetch();
      return;
    }
    if (readinessError) {
      void healReadiness();
      return;
    }
    if (complete.isError) {
      complete.reset();
      return;
    }
    if (
      prepareTools.isError ||
      (handoffSlow && !!binding && binding.cli.state !== "ready" && binding.cli.state !== "offline")
    ) {
      prepareToolsMutate({ retry: true });
      setHandoffStartedAt(Date.now());
      setHandoffSlow(false);
      void feishuQuery.refetch();
      return;
    }
    if (bindingNeedsRegistration || startFeishu.isError) {
      startFeishu.reset();
      setRegistrationRequestedFor(null);
      setHandoffStartedAt(Date.now());
      setHandoffSlow(false);
      void feishuQuery.refetch();
      return;
    }
    computer.refreshCapabilities?.();
    setHandoffStartedAt(Date.now());
    setHandoffSlow(false);
    startFeishu.reset();
    setRegistrationRequestedFor(null);
    void feishuQuery.refetch();
  };

  const runtimeCommand =
    viewSelectedRuntime && viewRuntimeState.kind === "install"
      ? runtimeProviderComputerSetupCommand(viewSelectedRuntime)
      : null;
  return (
    <OpenTagShell
      displayName={visibleDisplayName}
      identityState={identityState}
      editingName={!agent && editingName}
      onEditName={() => setEditingName(true)}
      onCancelEditName={() => setEditingName(false)}
      onNameChange={(name) => {
        setDisplayName(name);
        setRecoverableAgent(null);
        create.reset();
      }}
    >
      {facts.state === "unreadable" || facts.state === "team-unreadable" ? (
        <RecoverableReadError
          message={
            facts.state === "team-unreadable"
              ? "We couldn’t load your Team. Nothing has been created."
              : "We couldn’t load your agent. Nothing was lost."
          }
          onRetry={() => {
            if (facts.state === "team-unreadable") void refreshMeStrict().catch(() => undefined);
            else void agentQuery.refetch();
          }}
        />
      ) : (
        <OpenTagView
          pageState={pageState}
          connectedClients={viewClients}
          selectedClientId={viewSelectedClientId}
          onSelectClient={(clientId) => computer.setSelectedClientId(clientId)}
          runtimeState={viewRuntimeState}
          runtimeChoices={viewRuntimeChoices}
          selectedRuntime={viewSelectedRuntime}
          onSelectRuntime={setSelectedLocalAgent}
          displayName={visibleDisplayName}
          bootstrapCommand={computer.cliCommand}
          bootstrapError={computer.tokenError}
          onRetryBootstrap={computer.retry}
          runtimeCommand={runtimeCommand}
          updateCommand={!agent ? updateCommand : null}
          creating={create.isPending}
          createError={create.error instanceof Error ? create.error.message : null}
          recoverableAgent={recoverableAgent}
          onCreate={() => {
            if (!computer.selectedClientId || !selectedRuntime || !runtimeReady || create.isPending) return;
            create.mutate({ clientId: computer.selectedClientId, runtimeProvider: selectedRuntime });
          }}
          onContinueRecovery={() => {
            if (recoverableAgent) navigate(opentagEntryPath(recoverableAgent.uuid), { replace: true });
          }}
          signingIn={signIn.isPending || authStarting}
          signInError={signIn.error instanceof Error ? signIn.error.message : null}
          onSignIn={() => {
            if (!computer.selectedClientId || !selectedRuntime || signIn.isPending || authStarting) return;
            const provider = runtimeProviderInProductAuthTarget(selectedRuntime);
            if (!provider) return;
            signIn.mutate({ clientId: computer.selectedClientId, provider });
          }}
          onRefreshRuntime={() => computer.refreshCapabilities?.()}
          feishu={{
            appId: binding?.appId ?? null,
            registrationUrl: binding?.status === "provisioning" ? binding.registrationUrl : null,
            starting: startFeishu.isPending || (!binding && feishuQuery.isPending),
            preparingTools:
              prepareTools.isPending || binding?.cli.state === "missing" || binding?.cli.state === "unknown",
            botConnected: !!binding && isFeishuBotReachable(binding),
            error: feishuError,
            retryable: !ownershipBlocksRegistration,
            retrying: startFeishu.isPending || prepareTools.isPending || complete.isPending,
            onRetry: retryFeishu,
          }}
        />
      )}
    </OpenTagShell>
  );
}

function runtimeStatusCopy(entry: CapabilityEntry | null | undefined): string {
  if (runtimeIsReady(entry)) return "Ready";
  if (runtimeHasLivePendingAuth(entry)) return "Sign-in open";
  if (entry?.lastAuthError) return "Sign in required";
  if (entry?.state === "missing") return "Install required";
  if (entry?.state === "error") return "Check failed";
  return "Checking";
}

function RecoverableReadError({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div>
      <h2 className="text-headline font-semibold" style={{ margin: 0 }}>
        We couldn’t continue
      </h2>
      <p className="text-lead" role="alert" style={{ color: "var(--fg-2)" }}>
        {message}
      </p>
      <div
        data-opentag-action
        className="flex w-full items-center justify-between text-opentag-action"
        style={{
          minHeight: "var(--opentag-action-height)",
          padding: "var(--sp-8)",
          borderRadius: "var(--radius-opentag-action)",
          background: "var(--opentag-action)",
          color: "var(--opentag-action-fg)",
        }}
      >
        <p className="text-lead" style={{ margin: 0 }}>
          Your progress is safe.
        </p>
        <Button
          type="button"
          variant="cta"
          className="opentag-primary-action h-[var(--opentag-cta-height)] rounded-[var(--radius-opentag-cta)] px-7 text-lead font-semibold"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
