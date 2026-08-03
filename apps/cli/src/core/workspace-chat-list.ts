import type { FirstTreeHubSDK } from "@first-tree/client";
import type {
  ChatDetail,
  ChatEngagementStatus,
  ChatEngagementView,
  WorkspaceChatListResponse,
} from "@first-tree/shared";

/**
 * Exact-chat Workspace item: the member chat detail plus `id`/`chatId`
 * aliases (the detail payload only carries `id`; the conversation-row shape
 * uses `chatId`, so automation can read either uniformly across both forms).
 * Kept separate from shared's `WorkspaceChatListItem` (which extends the
 * conversation-row shape): the exact archive preflight returns the richer
 * detail payload — including the raw chat `metadata` where the SCM
 * entityKey/URL lives — not a conversation row.
 */
export type WorkspaceChatExactListItem = ChatDetail & { id: string; chatId: string };

/** Exact-chat preflight result: at most one item, never paginated. */
export type WorkspaceChatExactListResponse = {
  items: WorkspaceChatExactListItem[];
  nextCursor: null;
};

/**
 * List the signed-in human's Workspace conversation projection restricted to
 * chats where the SDK's agent is a speaker. The agent's organization is
 * resolved via `GET /agent/me`; the `with` filter runs server-side.
 */
export async function listWorkspaceChatsForAgent(
  sdk: FirstTreeHubSDK,
  options: { engagement: ChatEngagementView; limit?: number; cursor?: string },
): Promise<WorkspaceChatListResponse> {
  const organizationId = await sdk.getAgentOrganizationId();
  return sdk.listWorkspaceChats(organizationId, {
    engagement: options.engagement,
    withAgentId: sdk.agentId,
    limit: options.limit,
    cursor: options.cursor,
  });
}

/**
 * Whether the caller's current engagement status belongs to the requested
 * view. `all` is the union of the two listable tabs; a `deleted` row never
 * matches any view (deleted chats are excluded from the Workspace list and
 * are not archivable targets).
 */
function engagementMatchesView(status: ChatEngagementStatus, view: ChatEngagementView): boolean {
  if (view === "all") return status === "active" || status === "archived";
  return status === view;
}

/**
 * Read-only preflight immediately before `chat archive`: fetch one chat
 * through the member API and return it only when the SDK's agent is a speaker
 * in that chat AND the human's current engagement matches the requested view.
 * Anything else yields an empty item list — the caller archives nothing.
 */
export async function getWorkspaceChatExactForAgent(
  sdk: FirstTreeHubSDK,
  chatId: string,
  engagement: ChatEngagementView,
): Promise<WorkspaceChatExactListResponse> {
  const detail = await sdk.getMemberChatDetail(chatId);
  const agentId = sdk.agentId;
  const isSpeaker = agentId !== undefined && detail.participants.some((participant) => participant.agentId === agentId);
  if (!isSpeaker || !engagementMatchesView(detail.engagementStatus, engagement)) {
    return { items: [], nextCursor: null };
  }
  return { items: [{ ...detail, id: detail.id, chatId: detail.id }], nextCursor: null };
}
