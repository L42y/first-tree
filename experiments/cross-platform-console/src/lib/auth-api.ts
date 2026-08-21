import type { LoginResponse, MeMembership } from "@first-tree/shared";
import { loginResponseSchema } from "@first-tree/shared";
import { api } from "./api";
import { setStoredTokens } from "./api";

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

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await api.post<unknown>("/auth/login", { username, password });
  const parsed = loginResponseSchema.parse(res);
  await setStoredTokens(parsed);
  return parsed;
}

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>("/me", { signal });
}
