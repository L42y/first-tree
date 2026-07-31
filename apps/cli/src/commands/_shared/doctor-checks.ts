import { FirstTreeHubSDK, probeCapabilities } from "@first-tree/client";
import { clientConfigSchema, initConfig, resetConfig, resetConfigMeta } from "@first-tree/shared/config";
import type { CheckResult } from "../../core/doctor.js";
import {
  CLI_USER_AGENT,
  checkAgentConfigs,
  checkBackgroundService,
  checkClientConfig,
  checkDaemonRuntimeOwnership,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  ensureFreshAccessToken,
  reconcileAgentConfigs,
  resolveServerUrl,
  runtimeProviderChecks,
} from "../../core/index.js";

/**
 * Runtime-provider readiness: a resolve-only capability detection per built-in
 * provider, rendered one CheckResult per provider. Detection only locates each
 * provider's executable and checks platform support — it never launches the
 * provider, checks authentication, or makes model calls, so it stays cheap;
 * provider credentials are validated on the first real provider turn.
 * Detection failures are captured per-provider (never thrown), so this never
 * rejects.
 */
export async function checkRuntimeProviders(): Promise<CheckResult[]> {
  return runtimeProviderChecks(await probeCapabilities());
}

/**
 * Daemon-side readiness checks. Shared by `daemon doctor` (which renders
 * exactly this list) and the top-level `doctor` (which will append cross-
 * subsystem checks once more package-specific checks are wired through). Keeping
 * the check list in one place means a regression / new check only gets
 * authored once.
 *
 * Returns the same shape `printResults` expects so callers can render it
 * directly, or splice it into a larger array before rendering.
 */
export async function runDaemonChecks(): Promise<CheckResult[]> {
  // The "Agents" line cross-references local aliases against the server's
  // pinned-agent set, filtered to THIS client.id (so the verdict matches
  // what R-RUN will accept). Without a configured server URL we can't talk
  // to anything; fall back to the legacy local-only count.
  let agentCheck: CheckResult;
  try {
    const serverUrl = resolveServerUrl();
    const cfg = await initConfig({ schema: clientConfigSchema, role: "client" });
    const sdk = new FirstTreeHubSDK({
      serverUrl,
      getAccessToken: (opts) => ensureFreshAccessToken(opts),
      userAgent: CLI_USER_AGENT,
    });
    agentCheck = await reconcileAgentConfigs({
      clientId: cfg.client.id,
      listPinnedAgents: () => sdk.listMyAgents(),
    });
  } catch {
    agentCheck = checkAgentConfigs();
  } finally {
    // Doctor is read-only; release the singleton so subsequent commands
    // re-resolve config cleanly.
    resetConfig();
    resetConfigMeta();
  }

  return [
    checkNodeVersion(),
    checkClientConfig(),
    await checkServerReachable(),
    agentCheck,
    await checkWebSocket(),
    checkBackgroundService(),
    checkDaemonRuntimeOwnership(),
    ...(await checkRuntimeProviders()),
  ];
}
