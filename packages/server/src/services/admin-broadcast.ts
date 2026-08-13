/**
 * Service-layer seam for pushing payloads to admin WebSocket sockets.
 *
 * `registerAdminBroadcaster` wires the per-instance fanout to admin sockets
 * attached to THIS server process (called by orgWsRoutes once the admin route
 * is up). Producers call `broadcastToAdmins`.
 */

export type AdminBroadcastPayload = Record<string, unknown>;
export type AdminBroadcaster = (payload: AdminBroadcastPayload) => Promise<void> | void;

let localBroadcaster: AdminBroadcaster | null = null;

export function registerAdminBroadcaster(fn: AdminBroadcaster): void {
  localBroadcaster = fn;
}

export function resetAdminBroadcaster(): void {
  localBroadcaster = null;
}

export function broadcastToAdmins(payload: AdminBroadcastPayload): void {
  if (!localBroadcaster) return;
  try {
    void Promise.resolve(localBroadcaster(payload)).catch(() => {});
  } catch {
    // fire-and-forget
  }
}
