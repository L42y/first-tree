type Listener = () => void;

class SimpleEventBus {
  private listeners: Map<string, Set<Listener>> = new Map();

  on(event: string, listener: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach((listener) => listener());
  }
}

export const appEvents = new SimpleEventBus();

export const AUTH_LOGOUT_EVENT = "auth:logout";
export const ADMIN_WS_ORG_CHANGED_EVENT = "admin-ws:org-changed";
