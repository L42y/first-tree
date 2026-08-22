import { api } from "./api";

/** Sign-in identities + provider availability (`GET /me/auth-providers`). */
export type AuthProvidersResponse = {
  providers: Array<{
    provider: "google" | "github";
    connected?: boolean;
    identifier?: string | null;
    email?: string | null;
    canUnlink?: boolean;
  }>;
};

export async function getMyAuthProviders(signal?: AbortSignal): Promise<AuthProvidersResponse> {
  return api.get<AuthProvidersResponse>("/me/auth-providers", { signal });
}

/** Repos the GitHub App can access (`GET /me/github/repos`). */
export async function listGitHubRepos(
  signal?: AbortSignal,
): Promise<{ items: Array<{ fullName?: string; name?: string }> }> {
  return api.get<{ items: Array<{ fullName?: string; name?: string }> }>("/me/github/repos", { signal });
}
