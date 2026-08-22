import type { ContextTreeSnapshot } from "@first-tree/shared";
import { contextTreeSnapshotSchema } from "@first-tree/shared";
import { api, withOrg } from "./api";

export type ContextTreeWindow = "1d" | "7d" | "30d";

/** Read-only Context feed — same source as the web console's Context page. */
export async function getContextTreeSnapshot(
  window: ContextTreeWindow,
  signal?: AbortSignal,
): Promise<ContextTreeSnapshot> {
  return contextTreeSnapshotSchema.parse(
    await api.get<unknown>(withOrg(`/context-tree/snapshot?window=${encodeURIComponent(window)}`), { signal }),
  );
}
