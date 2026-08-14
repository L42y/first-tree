import {
  type Agent,
  type CapabilityEntry,
  type RuntimeProvider,
  runtimeProviderInProductAuthTarget,
} from "@first-tree/shared";
import { canManageAgentDetail } from "../agent-detail/access.js";

export type OpenTagAgentRead = {
  organizationId: string | null;
  meAuthoritative: boolean;
  memberId: string | null;
  role: string | null;
  agentUuid: string | null;
  loading: boolean;
  failed: boolean;
  errorStatus: number | null;
  agent: Pick<Agent, "organizationId" | "type" | "status" | "clientId" | "managerId" | "visibility"> | null;
};

export type OpenTagAgentFacts =
  | { state: "none" }
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "unreadable" }
  | { state: "team-unreadable" }
  | { state: "resolved" };

/**
 * Classify only authoritative Team and Agent facts. The URL remains the sole
 * recovery anchor after creation: transport failures never discard it, while
 * a missing, foreign, private, suspended, or unmanageable Agent is rejected.
 */
export function classifyOpenTagAgent(read: OpenTagAgentRead): OpenTagAgentFacts {
  if (!read.meAuthoritative || !read.organizationId) return { state: "team-unreadable" };
  if (!read.agentUuid) return { state: "none" };
  if (read.loading) return { state: "loading" };
  if (read.errorStatus === 404 || read.errorStatus === 403 || read.errorStatus === 410) {
    return { state: "unavailable" };
  }
  if (read.failed && !read.agent) return { state: "unreadable" };
  if (!read.agent) return { state: "loading" };
  if (read.agent.organizationId !== read.organizationId) return { state: "unavailable" };
  if (read.agent.type === "human" || read.agent.status !== "active") return { state: "unavailable" };
  if (!canManageAgentDetail(read.agent, read.memberId, read.role)) return { state: "unavailable" };
  if (read.agent.visibility !== "organization" || read.agent.clientId === null) return { state: "unavailable" };
  return { state: "resolved" };
}

export type OpenTagRuntimeState =
  | { kind: "checking" }
  | { kind: "ready"; provider: RuntimeProvider }
  | { kind: "signing-in"; provider: RuntimeProvider; authUrl?: string }
  | { kind: "sign-in"; provider: RuntimeProvider }
  | { kind: "install"; provider: RuntimeProvider }
  | { kind: "unavailable"; provider: RuntimeProvider };

/** A capability is executable for this flow only when no live auth recovery is outstanding. */
export function runtimeIsReady(entry: CapabilityEntry | null | undefined, nowMs = Date.now()): boolean {
  return entry?.state === "ok" && !runtimeHasLivePendingAuth(entry, nowMs) && !entry.lastAuthError;
}

export function deriveOpenTagRuntimeState({
  capabilitiesLoaded,
  provider,
  entry,
  nowMs = Date.now(),
}: {
  capabilitiesLoaded: boolean;
  provider: RuntimeProvider | null;
  entry: CapabilityEntry | null | undefined;
  nowMs?: number;
}): OpenTagRuntimeState {
  if (!capabilitiesLoaded || !provider) return { kind: "checking" };
  const pendingAuth = runtimeHasLivePendingAuth(entry, nowMs);
  if (pendingAuth) {
    return {
      kind: "signing-in",
      provider,
      ...(pendingAuth.authUrl ? { authUrl: pendingAuth.authUrl } : {}),
    };
  }
  if (entry?.state === "ok" && entry.lastAuthError) {
    return runtimeProviderInProductAuthTarget(provider) ? { kind: "sign-in", provider } : { kind: "install", provider };
  }
  if (entry?.state === "ok") return { kind: "ready", provider };
  if (entry?.state === "missing" || !entry) return { kind: "install", provider };
  return { kind: "unavailable", provider };
}

export function runtimeHasLivePendingAuth(
  entry: CapabilityEntry | null | undefined,
  nowMs = Date.now(),
): CapabilityEntry["pendingAuth"] {
  const pendingAuth = entry?.pendingAuth;
  if (!pendingAuth) return null;
  const expiresMs = Date.parse(pendingAuth.expiresAt);
  return Number.isNaN(expiresMs) || expiresMs > nowMs ? pendingAuth : null;
}

export type OpenTagPageState = "connect-computer" | "agent-blocked" | "create-agent" | "add-to-feishu" | "ready";

/** The five visual states of the one-page flow; no stored step index exists. */
export function resolveOpenTagPageState({
  hasCreatedAgent,
  hasComputer,
  runtimeReady,
  handoffReady,
}: {
  hasCreatedAgent: boolean;
  hasComputer: boolean;
  runtimeReady: boolean;
  handoffReady: boolean;
}): OpenTagPageState {
  if (hasCreatedAgent) return handoffReady ? "ready" : "add-to-feishu";
  if (!hasComputer) return "connect-computer";
  if (!runtimeReady) return "agent-blocked";
  return "create-agent";
}
