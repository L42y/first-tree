import { API_BASE, TOKEN_KEY } from "./env";
import { AUTH_LOGOUT_EVENT, appEvents } from "./events";
import { getItem, removeItem, type StoredTokens, setItem } from "./storage";

let selectedOrganizationId: string | null = null;

export function setApiSelectedOrganizationId(value: string | null): void {
  selectedOrganizationId = value;
}

export function getApiSelectedOrganizationId(): string | null {
  return selectedOrganizationId;
}

export function withOrg(path: string): string {
  if (!selectedOrganizationId) {
    throw new Error(`withOrg("${path}") called before an organization is selected`);
  }
  return `/orgs/${encodeURIComponent(selectedOrganizationId)}${path}`;
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  return getItem<StoredTokens>(TOKEN_KEY);
}

export async function setStoredTokens(tokens: StoredTokens): Promise<void> {
  await setItem(TOKEN_KEY, tokens);
}

export async function clearStoredTokens(): Promise<void> {
  await removeItem(TOKEN_KEY);
}

export type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code?: string;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: ValidationIssue[],
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshPromise: Promise<StoredTokens | null> | null = null;

export async function refreshAccessToken(): Promise<StoredTokens | null> {
  const tokens = await getStoredTokens();
  if (!tokens?.refreshToken) return null;
  return tryRefresh(tokens.refreshToken);
}

async function tryRefresh(refreshToken: string): Promise<StoredTokens | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string; refreshToken?: string };
      const updated: StoredTokens = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? refreshToken,
      };
      await setStoredTokens(updated);
      return updated;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  const { method = "GET", body, signal, headers: extraHeaders } = options ?? {};

  const doFetch = (token?: string) => {
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  };

  const tokens = await getStoredTokens();
  let res = await doFetch(tokens?.accessToken);

  if (res.status === 401 && tokens?.refreshToken) {
    const refreshed = await tryRefresh(tokens.refreshToken);
    if (refreshed) {
      res = await doFetch(refreshed.accessToken);
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      await clearStoredTokens();
      appEvents.emit(AUTH_LOGOUT_EVENT);
    }
    const text = await res.text();
    let message: string;
    let issues: ValidationIssue[] | undefined;
    let code: string | undefined;
    try {
      const json = JSON.parse(text) as { error?: string; code?: string; details?: unknown };
      message = json.error ?? text;
      code = typeof json.code === "string" ? json.code : undefined;
      if (Array.isArray(json.details)) {
        issues = json.details.filter(
          (d): d is ValidationIssue =>
            typeof d === "object" && d !== null && Array.isArray((d as { path?: unknown }).path),
        );
      }
    } catch {
      message = text;
    }
    throw new ApiError(res.status, message, issues, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) => request<T>(path, options),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }) =>
    request<T>(path, { method: "PATCH", body, headers: options?.headers }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  delete: <T>(path: string, options?: { headers?: Record<string, string> }) =>
    request<T>(path, { method: "DELETE", headers: options?.headers }),
};
