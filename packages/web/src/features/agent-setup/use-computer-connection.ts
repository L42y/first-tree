import { type ClientCapabilities, enabledOkRuntimeProviders, type RuntimeProvider } from "@first-tree/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectTokenResponse, getClientCapabilities, type HubClient, listClients } from "../../api/activity.js";
import { api } from "../../api/client.js";
import { runVisibilityAwareInterval } from "../../lib/visibility-interval.js";
import { resolveComputerSelection, resolveRuntimeSelection } from "./computer-selection.js";

const CLIENT_DETECT_POLL_MS = 5_000;

/**
 * Watches for the user's computer coming online and figures out whether it
 * can host an agent.
 *
 * Lifecycle (mirrors the proven logic from the legacy Step2Body):
 *   1. Mint a short-lived connect token + bootstrap command (the command block
 *      the user pastes into their terminal).
 *   2. Poll `listClients()` and keep the connected-computer roster current.
 *      A sole computer is automatic; multi-computer creation can require an
 *      explicit choice instead of using heartbeat order.
 *   3. Fetch capabilities for the selected computer to learn which runtimes
 *      are ready, and auto-pick via the shared Codex-first catalog priority.
 *
 * Pure presentation state is returned; the React step renders it. Polling
 * pauses while the tab is hidden (`runVisibilityAwareInterval`) and stops
 * entirely when `enabled` is false.
 */
export type ComputerConnection = {
  connectedClients: HubClient[];
  selectedClientId: string | null;
  setSelectedClientId: (next: string | null) => void;
  connectedClient: HubClient | null;
  capabilitiesLoaded: boolean;
  /** Enabled `ok` providers in catalog display order. */
  okRuntimes: RuntimeProvider[];
  selectedRuntime: RuntimeProvider | null;
  setSelectedRuntime: (next: RuntimeProvider | null) => void;
  /** The full multi-line command the user pastes into their terminal. */
  cliCommand: string | null;
  /** Non-null when minting the connect token failed (after silent retries). */
  tokenError: string | null;
  /** Manually re-attempt minting the connect token (clears `tokenError`). */
  retry: () => void;
};

export type UseComputerConnectionOptions = {
  /** Called once after the final automatic connect-token mint attempt fails. */
  onTokenMintFailed?: () => void;
  /**
   * Whether this surface currently needs a bootstrap command. Detection stays
   * live when false, but no short-lived connect code is minted until the user
   * reaches a surface that can actually use it.
   */
  allowBootstrapMint?: boolean;
  /**
   * Prepare a portable login fallback even when another Client is already
   * connected. BYO onboarding cannot assume the coding-agent conversation is
   * running on the same computer represented by the Web's global signal.
   */
  prepareBootstrapWhenConnected?: boolean;
  /**
   * Do not silently choose between multiple connected computers. The one-
   * computer path remains automatic; callers render a picker when this leaves
   * `selectedClientId` null.
   */
  requireExplicitSelectionWhenMultiple?: boolean;
};

/** Silent auto-retries before surfacing a token-mint failure to the user. */
const TOKEN_MINT_ATTEMPTS = 3;
const TOKEN_MINT_BACKOFF_MS = [600, 1500];

function hasReportedCapabilities(caps: ClientCapabilities | null): caps is ClientCapabilities {
  return !!caps && Object.keys(caps).length > 0;
}

export function useComputerConnection(
  enabled: boolean,
  options: UseComputerConnectionOptions = {},
): ComputerConnection {
  const [connectedClients, setConnectedClients] = useState<HubClient[]>([]);
  const [selectedClientIdState, setSelectedClientIdState] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [selectedRuntimeState, setSelectedRuntimeState] = useState<RuntimeProvider | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Bumped by retry() to force a fresh mint attempt from the effect below.
  const [retryNonce, setRetryNonce] = useState(0);

  const clientDetectSeqRef = useRef(0);
  const capabilitiesDetectSeqRef = useRef(0);
  const explicitlySelectedClientIdRef = useRef<string | null>(null);
  const runtimeSelectionIsManualRef = useRef(false);
  const onTokenMintFailedRef = useRef(options.onTokenMintFailed);
  onTokenMintFailedRef.current = options.onTokenMintFailed;

  // Detect all connected computers. Selection and capability polling are
  // separate so a multi-computer create step can pause for an explicit choice
  // instead of fetching from the most-recent heartbeat implicitly.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      const seq = ++clientDetectSeqRef.current;
      try {
        const clients = await listClients();
        if (cancelled || seq !== clientDetectSeqRef.current) return;
        const connected = clients
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        setConnectedClients(connected);
      } catch {
        // best-effort
      }
    };
    const dispose = runVisibilityAwareInterval(detect, CLIENT_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [enabled]);

  const clientIds = useMemo(() => connectedClients.map((client) => client.id), [connectedClients]);
  const selectedClientId = resolveComputerSelection({
    clientIds,
    currentClientId: selectedClientIdState,
    explicitlySelectedClientId: explicitlySelectedClientIdRef.current,
    requireExplicitWhenMultiple: options.requireExplicitSelectionWhenMultiple === true,
  });

  const setSelectedClientId = useCallback((next: string | null): void => {
    explicitlySelectedClientIdRef.current = next;
    setSelectedClientIdState(next);
  }, []);

  // Keep storage aligned with the synchronously-derived effective choice. The
  // render never exposes a stale automatic choice while this effect catches up.
  useEffect(() => {
    const explicitClientId = explicitlySelectedClientIdRef.current;
    if (explicitClientId && !clientIds.includes(explicitClientId)) {
      explicitlySelectedClientIdRef.current = null;
    }
    setSelectedClientIdState((prev) => (prev === selectedClientId ? prev : selectedClientId));
  }, [clientIds, selectedClientId]);

  const connectedClient = useMemo(
    () => connectedClients.find((client) => client.id === selectedClientId) ?? null,
    [connectedClients, selectedClientId],
  );

  // Poll capabilities only for the chosen computer. A stale response from a
  // previous choice cannot become active because both sequence and client id
  // are checked before committing it.
  useEffect(() => {
    if (!enabled || !selectedClientId) {
      capabilitiesDetectSeqRef.current += 1;
      setCapabilitiesClientId(null);
      setCapabilities(null);
      return;
    }
    let cancelled = false;
    setCapabilitiesClientId(null);
    setCapabilities(null);
    const detectCapabilities = async (): Promise<void> => {
      const seq = ++capabilitiesDetectSeqRef.current;
      try {
        const withCaps = await getClientCapabilities(selectedClientId);
        if (cancelled || seq !== capabilitiesDetectSeqRef.current) return;
        setCapabilitiesClientId(selectedClientId);
        setCapabilities(withCaps.capabilities);
      } catch {
        // The interval owns retry timing; an explicit return keeps the last
        // successful snapshot inactive only when the selected client changed.
        return;
      }
    };
    const dispose = runVisibilityAwareInterval(detectCapabilities, CLIENT_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [enabled, selectedClientId]);

  // Mint / refresh the connect token while no computer is connected yet.
  // retryNonce in the deps is an intentional re-run trigger (bumped by retry()
  // after a failure); it isn't read inside, hence the suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate trigger dep
  useEffect(() => {
    if (!enabled) return;
    if (options.allowBootstrapMint === false) return;
    if (connectedClients.length > 0 && !options.prepareBootstrapWhenConnected) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      setConnectToken(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      // Most token-mint failures are a momentary blip (network, server warming
      // up), so retry silently a couple of times before showing the user an
      // error — they usually never see one. Only the final failure surfaces.
      setTokenError(null);
      for (let attempt = 0; attempt < TOKEN_MINT_ATTEMPTS; attempt++) {
        if (cancelled) return;
        try {
          const r = await api.post<ConnectTokenResponse>("/me/connect-tokens", {});
          if (cancelled) return;
          setConnectToken(r.token);
          setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
          setBootstrapCommand(r.bootstrapCommand);
          setTokenError(null);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === TOKEN_MINT_ATTEMPTS - 1) {
            setTokenError(err instanceof Error ? err.message : "Failed to generate connect command");
            onTokenMintFailedRef.current?.();
            return;
          }
          // Silent backoff before the next attempt.
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, TOKEN_MINT_BACKOFF_MS[attempt] ?? 1500);
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    connectedClients.length,
    connectToken,
    connectTokenExpiresAt,
    options.allowBootstrapMint,
    options.prepareBootstrapWhenConnected,
    retryNonce,
  ]);

  // Manual retry from the error UI: clear the error + token so the mint effect
  // re-runs from scratch.
  const retry = useCallback(() => {
    setTokenError(null);
    setConnectToken(null);
    setConnectTokenExpiresAt(null);
    setRetryNonce((n) => n + 1);
  }, []);

  const activeCapabilities =
    connectedClient && capabilitiesClientId === connectedClient.id && hasReportedCapabilities(capabilities)
      ? capabilities
      : null;
  const okRuntimes = useMemo(
    () => (activeCapabilities ? enabledOkRuntimeProviders(activeCapabilities) : []),
    [activeCapabilities],
  );

  // Auto-pick via the catalog preference prefix while preserving Client order;
  // keep a still-valid prior choice.
  useEffect(() => {
    setSelectedRuntimeState((prev) => {
      if (!activeCapabilities) return prev;
      const next = resolveRuntimeSelection({
        currentRuntime: prev,
        selectionIsManual: runtimeSelectionIsManualRef.current,
        readyRuntimes: okRuntimes,
      });
      runtimeSelectionIsManualRef.current = next.selectionIsManual;
      return next.runtime;
    });
  }, [activeCapabilities, okRuntimes]);

  const setSelectedRuntime = useCallback((next: RuntimeProvider | null): void => {
    runtimeSelectionIsManualRef.current = next !== null;
    setSelectedRuntimeState(next);
  }, []);

  const cliCommand = bootstrapCommand;

  return {
    connectedClients,
    selectedClientId,
    setSelectedClientId,
    connectedClient,
    capabilitiesLoaded: activeCapabilities !== null,
    okRuntimes,
    selectedRuntime: selectedRuntimeState,
    setSelectedRuntime,
    cliCommand,
    tokenError,
    retry,
  };
}
