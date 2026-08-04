import { type ClientCapabilities, isRuntimeProviderEnabled } from "@first-tree/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, getClientCapabilities, type HubClient, listClients } from "../../api/activity.js";
import { api } from "../../api/client.js";
import { runVisibilityAwareInterval } from "../../lib/visibility-interval.js";
import { orderRuntimesByPreference, pickPreferredRuntime } from "./runtime-preference.js";

const CLIENT_DETECT_POLL_MS = 5_000;

/**
 * Watches for the user's computer coming online and figures out whether it
 * can host an agent.
 *
 * Lifecycle (mirrors the proven logic from the legacy Step2Body):
 *   1. Mint a short-lived connect token + bootstrap command (the command block
 *      the user pastes into their terminal).
 *   2. Poll `listClients()`; the most-recently-seen connected client wins.
 *   3. Once a client is connected, fetch its capabilities to learn which AI
 *      runtimes are ready, and auto-pick the best one (Codex → Claude Code).
 *
 * Pure presentation state is returned; the React step renders it. Polling
 * pauses while the tab is hidden (`runVisibilityAwareInterval`) and stops
 * entirely when `enabled` is false.
 */
export type ComputerConnection = {
  connectedClient: HubClient | null;
  capabilitiesLoaded: boolean;
  okRuntimes: string[];
  selectedRuntime: string | null;
  setSelectedRuntime: (next: string | null) => void;
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
};

/** Silent auto-retries before surfacing a token-mint failure to the user. */
const TOKEN_MINT_ATTEMPTS = 3;
const TOKEN_MINT_BACKOFF_MS = [600, 1500];
function listReadyRuntimes(caps: ClientCapabilities): string[] {
  // Never include a temporarily-disabled provider, even if a stale snapshot
  // still reports it `ok`.
  return orderRuntimesByPreference(
    Object.entries(caps)
      .filter(([provider, entry]) => entry.state === "ok" && isRuntimeProviderEnabled(provider))
      .map(([provider]) => provider),
  );
}

function hasReportedCapabilities(caps: ClientCapabilities | null): caps is ClientCapabilities {
  return !!caps && Object.keys(caps).length > 0;
}

export function useComputerConnection(
  enabled: boolean,
  options: UseComputerConnectionOptions = {},
): ComputerConnection {
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Bumped by retry() to force a fresh mint attempt from the effect below.
  const [retryNonce, setRetryNonce] = useState(0);

  const capabilitiesClientIdRef = useRef<string | null>(null);
  const detectSeqRef = useRef(0);
  const onTokenMintFailedRef = useRef(options.onTokenMintFailed);
  onTokenMintFailedRef.current = options.onTokenMintFailed;

  // Detect the connected computer + its capabilities.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      const seq = ++detectSeqRef.current;
      try {
        const clients = await listClients();
        if (cancelled || seq !== detectSeqRef.current) return;
        const connected = clients
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        const latest = connected[0] ?? null;
        setConnectedClient((prev) => (prev?.id === latest?.id ? prev : latest));
        if (latest) {
          if (capabilitiesClientIdRef.current !== latest.id) {
            capabilitiesClientIdRef.current = null;
            setCapabilitiesClientId(null);
            setCapabilities(null);
          }
          try {
            const withCaps = await getClientCapabilities(latest.id);
            if (cancelled || seq !== detectSeqRef.current) return;
            capabilitiesClientIdRef.current = latest.id;
            setCapabilitiesClientId(latest.id);
            setCapabilities(withCaps.capabilities);
          } catch {
            // transient — try again next tick
          }
        } else {
          capabilitiesClientIdRef.current = null;
          setCapabilitiesClientId(null);
          setCapabilities(null);
        }
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

  // Mint / refresh the connect token while no computer is connected yet.
  // retryNonce in the deps is an intentional re-run trigger (bumped by retry()
  // after a failure); it isn't read inside, hence the suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate trigger dep
  useEffect(() => {
    if (!enabled) return;
    if (options.allowBootstrapMint === false) return;
    if (connectedClient && !options.prepareBootstrapWhenConnected) return;
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
    connectedClient,
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

  // Auto-pick the preferred ready runtime; keep a still-valid prior choice.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!activeCapabilities) return prev;
      const ready = listReadyRuntimes(activeCapabilities);
      if (prev && ready.includes(prev)) return prev;
      return pickPreferredRuntime(ready);
    });
  }, [activeCapabilities]);

  const okRuntimes = activeCapabilities ? listReadyRuntimes(activeCapabilities) : [];

  const cliCommand = bootstrapCommand;

  return {
    connectedClient,
    capabilitiesLoaded: activeCapabilities !== null,
    okRuntimes,
    selectedRuntime,
    setSelectedRuntime,
    cliCommand,
    tokenError,
    retry,
  };
}
