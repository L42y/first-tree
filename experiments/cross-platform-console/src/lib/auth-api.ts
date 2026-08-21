import type { MeMembership } from "@first-tree/shared";
import { api } from "./api";

/**
 * Public bootstrap payload served by `GET /api/v1/bootstrap/config`
 * (packages/server/src/api/bootstrap/config.ts). The web console narrows
 * the same endpoint for its sign-in screen, so the Expo app reads the
 * identical source of truth for which OAuth providers this deployment
 * has configured — a self-hosted server without Google must never render
 * a broken "Continue with Google" button.
 */
export type AuthProviderAvailability = {
  google: boolean;
  github: boolean;
  oidc: boolean;
};

export type BootstrapConfig = {
  channel?: string;
  authMode?: string;
  authProviders?: AuthProviderAvailability;
};

export async function fetchBootstrapConfig(signal?: AbortSignal): Promise<BootstrapConfig> {
  return api.get<BootstrapConfig>("/bootstrap/config", { signal });
}

export const DEFAULT_PROVIDER_AVAILABILITY: AuthProviderAvailability = {
  google: false,
  github: false,
  oidc: false,
};

type MeUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type MeResponse = {
  user?: MeUser;
  defaultOrganizationId?: string | null;
  memberships?: MeMembership[];
};

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>("/me", { signal });
}
