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

export type GitHubRepo = {
  fullName: string;
  private: boolean;
};

/** Repos the GitHub App can access (`GET /me/github/repos`). */
export async function listGitHubRepos(signal?: AbortSignal): Promise<{ repos: GitHubRepo[] }> {
  return api.get<{ repos: GitHubRepo[] }>("/me/github/repos", { signal });
}
