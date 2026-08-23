import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { getApiSelectedOrganizationId, getStoredTokens } from "./api";
import { API_BASE_URL } from "./env";

/**
 * Realtime org channel — the mobile counterpart of the web console's
 * `use-admin-ws` (packages/web/src/hooks/use-admin-ws.ts):
 *
 *   wss://<host>/api/v1/orgs/<orgId>/ws/?token=<accessToken>
 *
 * Frames are `{ type, ...payload }`. We translate the frames the app
 * consumes into React Query invalidations (throttling is left to the
 * query layer's dedupe):
 *
 *   - chat:message      → chat list + that chat's message timeline
 *   - chat:updated      → chat list + chat detail
 *   - me-chats:changed  → chat list (private projection: pin/engagement)
 *   - membership:changed→ everything org-scoped (coarse: clear caches)
 *
 * Reconnects with capped backoff; silent no-op when logged out or no org
 * is selected (the effect re-runs when either becomes available).
 */

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function useOrgRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidateList = () =>
      queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });

    const connect = async () => {
      const tokens = await getStoredTokens();
      const orgId = getApiSelectedOrganizationId();
      if (!tokens?.accessToken || !orgId) {
        // Not ready yet — retry once on the backoff curve; the effect also
        // re-runs whenever auth state changes.
        scheduleReconnect();
        return;
      }

      const wsUrl = `wss://${new URL(API_BASE_URL).host}/api/v1/orgs/${encodeURIComponent(
        orgId,
      )}/ws/?token=${encodeURIComponent(tokens.accessToken)}`;

      const socketLocal = new WebSocket(wsUrl);
      socket = socketLocal;

      socketLocal.onopen = () => {
        attempt = 0;
      };

      socketLocal.onmessage = (event) => {
        let frame: { type?: string; chatId?: unknown };
        try {
          frame = JSON.parse(String(event.data)) as { type?: string; chatId?: unknown };
        } catch {
          return;
        }
        const chatId = typeof frame.chatId === "string" ? frame.chatId : null;

        if (frame.type === "chat:message") {
          invalidateList();
          if (chatId) {
            queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
            queryClient.invalidateQueries({ queryKey: ["chats", chatId] });
          }
        } else if (frame.type === "chat:updated") {
          invalidateList();
          if (chatId) {
            queryClient.invalidateQueries({ queryKey: ["chats", chatId] });
          }
        } else if (frame.type === "me-chats:changed") {
          invalidateList();
        } else if (frame.type === "membership:changed") {
          queryClient.clear();
        }
      };

      socketLocal.onclose = () => {
        if (socket === socketLocal) socket = null;
        scheduleReconnect();
      };

      socketLocal.onerror = () => {
        socketLocal.close();
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        if (!closed) connect();
      }, delay);
    };

    void connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    };
    // API_BASE_URL is build-constant; org/token changes re-mount via enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, queryClient]);
}

