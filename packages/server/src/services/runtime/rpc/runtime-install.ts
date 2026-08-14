import { clientWireCapabilitiesSchema } from "@first-tree/shared";

/** Installer hard timeout is eight minutes; leave thirty seconds for the result frame. */
export const RUNTIME_INSTALL_REPLY_TIMEOUT_MS = 8 * 60 * 1000 + 30_000;

export function metadataSupportsRuntimeInstallV1(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const wire = (metadata as Record<string, unknown>).wireCapabilities;
  const parsed = clientWireCapabilitiesSchema.safeParse(wire);
  return parsed.success && parsed.data.runtimeInstallV1 === true;
}

export function runtimeInstallClientLiveness(
  client: { status: string; instanceId: string | null; lastSeenAt: Date },
  now: Date,
  staleSeconds: number,
): "live" | "disconnected" | "stale" {
  if (client.status !== "connected" || !client.instanceId) return "disconnected";
  if (now.getTime() - client.lastSeenAt.getTime() > staleSeconds * 1000) return "stale";
  return "live";
}
