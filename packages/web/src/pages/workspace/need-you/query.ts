import type { ListNeedYouRequestsResponse } from "@first-tree/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { listNeedYouRequests } from "../../../api/me-chats.js";

export function needYouQueryKey(organizationId: string | null): readonly ["need-you", string | null] {
  return ["need-you", organizationId] as const;
}

/**
 * One shared queue query backs the desktop entry, mobile entry, and review
 * surface. The payload carries an exact total; keeping a single cache shape
 * prevents a count-only request from replacing the review page's item list.
 */
export function needYouQueryOptions(organizationId: string | null) {
  return queryOptions({
    queryKey: needYouQueryKey(organizationId),
    queryFn: ({ signal }) => listNeedYouRequests({ limit: 100 }, { signal }),
    enabled: organizationId !== null,
    refetchInterval: 5_000,
  });
}

/** Remove a successfully resolved request immediately; refetch reconciles. */
export function removeResolvedNeedYouRequest(
  queryClient: QueryClient,
  organizationId: string | null,
  requestId: string,
): void {
  queryClient.setQueryData<ListNeedYouRequestsResponse>(needYouQueryKey(organizationId), (current) => {
    if (!current) return current;
    const present = current.items.some((item) => item.request.id === requestId);
    if (!present) return current;
    return {
      ...current,
      items: current.items.filter((item) => item.request.id !== requestId),
      total: Math.max(0, current.total - 1),
    };
  });
}
