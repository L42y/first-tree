import type { MeMembership, OrgBrief } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { fetchMe, login as loginApi, type MeResponse } from "./auth-api";
import {
  clearStoredTokens,
  getApiSelectedOrganizationId,
  getStoredTokens,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "./api";
import { ADMIN_WS_ORG_CHANGED_EVENT, appEvents, AUTH_LOGOUT_EVENT } from "./events";
import { SELECTED_ORG_KEY } from "./env";
import { getItem, removeItem, setItem } from "./storage";

type MeUser = NonNullable<MeResponse["user"]>;

type AuthContextValue = {
  isAuthenticated: boolean;
  meLoaded: boolean;
  user: MeUser | null;
  memberships: MeMembership[];
  currentMembership: MeMembership | null;
  organizationId: string | null;
  memberId: string | null;
  role: string | null;
  agentId: string | null;
  teamDisplayName: string | null;
  switchingOrg: OrgBrief | null;
  setSwitchingOrg: (org: OrgBrief | null) => void;
  login: (username: string, password: string) => Promise<void>;
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  selectOrganization: (organizationId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

function userIdFromToken(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload)) as { sub?: string };
    return json.sub ?? null;
  } catch {
    return null;
  }
}

function selectedOrgKey(userId: string): string {
  return `${SELECTED_ORG_KEY}:${userId}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [tokens, setTokens] = useState<{ accessToken: string; refreshToken: string } | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [switchingOrg, setSwitchingOrg] = useState<OrgBrief | null>(null);

  const userId = useMemo(() => (tokens ? userIdFromToken(tokens.accessToken) : null), [tokens]);

  const applyMe = useCallback(
    async (response: MeResponse) => {
      setMe(response);
      const memberships = response.memberships ?? [];
      let selectedOrgId = getApiSelectedOrganizationId();

      if (!selectedOrgId && userId) {
        const storedOrg = await getItem<string>(selectedOrgKey(userId));
        if (storedOrg && memberships.some((m) => m.organizationId === storedOrg)) {
          selectedOrgId = storedOrg;
        }
      }

      if (!selectedOrgId && response.defaultOrganizationId) {
        selectedOrgId = response.defaultOrganizationId;
      }

      if (!selectedOrgId && memberships.length > 0) {
        selectedOrgId = memberships[0].organizationId;
      }

      const membership = memberships.find((m) => m.organizationId === selectedOrgId) ?? memberships[0] ?? null;
      if (membership) {
        setApiSelectedOrganizationId(membership.organizationId);
        if (userId) {
          await setItem(selectedOrgKey(userId), membership.organizationId);
        }
      } else {
        setApiSelectedOrganizationId(null);
      }
    },
    [userId],
  );

  const loadTokensAndMe = useCallback(async () => {
    const stored = await getStoredTokens();
    if (!stored) {
      setMeLoaded(true);
      return;
    }
    setTokens(stored);
    try {
      const response = await fetchMe();
      await applyMe(response);
    } catch {
      await clearStoredTokens();
      setTokens(null);
    } finally {
      setMeLoaded(true);
    }
  }, [applyMe]);

  useEffect(() => {
    loadTokensAndMe();
  }, [loadTokensAndMe]);

  useEffect(() => {
    return appEvents.on(AUTH_LOGOUT_EVENT, () => {
      void (async () => {
        await clearStoredTokens();
        setTokens(null);
        setMe(null);
        setMeLoaded(true);
        queryClient.clear();
      })();
    });
  }, [queryClient]);

  const refreshMe = useCallback(async () => {
    const response = await fetchMe();
    await applyMe(response);
    setMe(response);
  }, [applyMe]);

  const adoptTokens = useCallback(
    async (newTokens: { accessToken: string; refreshToken: string }) => {
      await setStoredTokens(newTokens);
      setTokens(newTokens);
      await refreshMe();
    },
    [refreshMe],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await loginApi(username, password);
      await adoptTokens(response);
    },
    [adoptTokens],
  );

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      const membership = me?.memberships?.find((m) => m.organizationId === organizationId);
      if (!membership) return;
      setApiSelectedOrganizationId(organizationId);
      if (userId) {
        await setItem(selectedOrgKey(userId), organizationId);
      }
      appEvents.emit(ADMIN_WS_ORG_CHANGED_EVENT);
      await refreshMe();
    },
    [me, userId, refreshMe],
  );

  const logout = useCallback(async () => {
    await clearStoredTokens();
    if (userId) {
      await removeItem(selectedOrgKey(userId));
    }
    setTokens(null);
    setMe(null);
    setApiSelectedOrganizationId(null);
    queryClient.clear();
  }, [userId, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const membership = me?.memberships?.find((m) => m.organizationId === getApiSelectedOrganizationId()) ?? null;
    return {
      isAuthenticated: !!tokens && !!me?.user,
      meLoaded,
      user: me?.user ?? null,
      memberships: me?.memberships ?? [],
      currentMembership: membership,
      organizationId: membership?.organizationId ?? null,
      memberId: membership?.id ?? null,
      role: membership?.role ?? null,
      agentId: membership?.agentId ?? null,
      teamDisplayName: membership?.organizationName ?? null,
      switchingOrg,
      setSwitchingOrg,
      login,
      adoptTokens,
      selectOrganization,
      refreshMe,
      logout,
    };
  }, [tokens, me, meLoaded, switchingOrg, login, adoptTokens, selectOrganization, refreshMe, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
