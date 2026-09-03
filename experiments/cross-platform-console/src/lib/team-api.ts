import type { OrgBrief } from "@first-tree/shared";

import { api, withOrg } from "./api";

/**
 * Team surface — mirrors the web console's cross-org agent list
 * (`GET /api/v1/me/managed-agents`, see packages/server/src/api/me.ts).
 */

export type ManagedAgent = {
  uuid: string;
  name: string;
  displayName: string;
  type: string;
  organizationId: string;
  inboxId: string | null;
  visibility: string;
  runtimeProvider: string | null;
  clientId: string | null;
  status: string;
  avatarImageUrl: string | null;
};

export async function listManagedAgents(signal?: AbortSignal): Promise<ManagedAgent[]> {
  return api.get<ManagedAgent[]>("/me/managed-agents", { signal });
}

export type MyOrganization = OrgBrief;

export type MeOrganizationsResponse = MyOrganization[];

/** Workspace switcher source (`GET /me/organizations`). */
export async function listMyOrganizations(signal?: AbortSignal): Promise<MeOrganizationsResponse> {
  return api.get<MeOrganizationsResponse>("/me/organizations", { signal });
}

export type MyClient = {
  id: string;
  status: string;
  authState: string;
  sdkVersion: string | null;
  hostname: string;
  os: string | null;
  agentCount: number;
  lastSeenAt: string;
};

/** Connected computers (`GET /me/clients`) — Settings roster source. */
export async function listMyClients(signal?: AbortSignal): Promise<MyClient[]> {
  return api.get<MyClient[]>("/me/clients", { signal });
}

export type CreateAgentInput = {
  name?: string;
  displayName?: string;
  type: "human" | "agent";
  visibility?: "private" | "organization";
  runtimeProvider?: string;
};

/** Create an agent (`POST {withOrg}/agents`, same body as web console). */
export async function createAgent(input: CreateAgentInput): Promise<ManagedAgent> {
  return api.post<ManagedAgent>(withOrg("/agents"), input);
}

export type UpdateAgentInput = {
  displayName?: string;
  visibility?: "private" | "organization";
};

/** Update an agent (`PATCH /agents/:uuid`, same fields as web console). */
export async function updateAgent(uuid: string, input: UpdateAgentInput): Promise<ManagedAgent> {
  return api.patch<ManagedAgent>(withOrg(`/agents/${encodeURIComponent(uuid)}`), input);
}

export type OrgAgent = {
  uuid: string;
  name: string | null;
  displayName: string;
  type: string;
  status: string;
  visibility: string;
  /** Which runtime drives this agent ("claude-code", "codex", …); null for humans. */
  runtimeProvider: string | null;
  /** Member who manages the agent — only they may read its runtime config. */
  managerId: string | null;
  /** Live presence joined from `agent_presence`; null when never connected. */
  presenceStatus: string | null;
  runtimeState: string | null;
  lastSeenAt: string | null;
  avatarColorToken: string | null;
  avatarImageUrl: string | null;
};

/**
 * Org roster the caller may address (`GET {withOrg}/agents`, the same source
 * the web console's add-participant picker uses). `addressableOnly` keeps the
 * result to identities that can actually join a chat; `query` is a
 * server-side substring match so orgs past the 100-row first page stay
 * reachable.
 */
export async function listOrgAgents(
  params?: { query?: string; limit?: number; addressableOnly?: boolean },
  signal?: AbortSignal,
): Promise<OrgAgent[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(params?.limit ?? 100));
  if (params?.addressableOnly ?? true) qs.set("addressableOnly", "true");
  if (params?.query) qs.set("query", params.query);
  const page = await api.get<{ items: OrgAgent[] }>(withOrg(`/agents?${qs.toString()}`), { signal });
  return page.items ?? [];
}

/** Pause an agent (`POST /agents/:uuid/suspend`) — it stops taking work. */
export async function suspendAgent(uuid: string): Promise<void> {
  await api.post(withOrg(`/agents/${encodeURIComponent(uuid)}/suspend`), {});
}

/** Resume a paused agent (`POST /agents/:uuid/reactivate`). */
export async function reactivateAgent(uuid: string): Promise<void> {
  await api.post(withOrg(`/agents/${encodeURIComponent(uuid)}/reactivate`), {});
}
