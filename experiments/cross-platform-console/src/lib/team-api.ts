import { api } from "./api";

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

export type MyOrganization = {
  id: string;
  name: string;
  displayName: string;
  role: string;
};

export type MeOrganizationsResponse = MyOrganization[];

/** Workspace switcher source (`GET /me/organizations`). */
export async function listMyOrganizations(signal?: AbortSignal): Promise<MeOrganizationsResponse> {
  return api.get<MeOrganizationsResponse>("/me/organizations", { signal });
}
