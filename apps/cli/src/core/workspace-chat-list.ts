import type { FirstTreeHubSDK } from "@first-tree/client";
import type {
  ChatEngagementStatus,
  ChatEngagementView,
  WorkspaceChatListItem,
  WorkspaceChatListResponse,
} from "@first-tree/shared";

/**
 * Exact-chat Workspace item: the Workspace conversation row (all attention
 * fields — `unreadMentionCount`, `openRequestCount`, `liveActivity`,
 * `failedAgentIds`, `busyAgentIds`, `createdByMe`, `source`, `entityType`,
 * `activityAt`, …) overlaid with the detail-only fields from the raw member
 * chat detail (`metadata` — where the SCM entityKey/URL lives —,
 * `firstMessagePreview`, `viewerMembershipKind`, `descriptionUpdatedAt`,
 * `lastReadAt`, `organizationId`, `lifecyclePolicy`, `createdAt`,
 * `updatedAt`). `engagementStatus` comes from the detail: it is the fresher
 * read and the current-state verdict for the archive preflight. `id` and
 * `chatId` both equal the target chat id.
 */
export type WorkspaceChatExactListItem = WorkspaceChatListItem & {
  metadata: Record<string, unknown>;
  firstMessagePreview: string | null;
  viewerMembershipKind: "participant" | "watching" | null;
  descriptionUpdatedAt: string | null;
  lastReadAt: string | null;
  organizationId: string;
  lifecyclePolicy?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Exact-chat preflight result: at most one item, never paginated. */
export type WorkspaceChatExactListResponse = {
  items: WorkspaceChatExactListItem[];
  nextCursor: null;
};

/** Page size for the exact-mode Workspace scan (the CLI's limit cap). */
const EXACT_SCAN_PAGE_SIZE = 100;

/**
 * Hard page bound for the exact-mode scan: 100 pages × 100 rows covers
 * 10,000 conversations. A server that keeps emitting distinct non-null
 * cursors past this bound is feeding an unbounded stream, so the preflight
 * fails closed instead of looping forever.
 */
const EXACT_SCAN_MAX_PAGES = 100;

/**
 * Fail closed when no agent is selected: without `withAgentId` the Workspace
 * list would expose the signed-in human's whole Workspace instead of the
 * agent-scoped subset.
 */
function requireSelectedAgentId(sdk: FirstTreeHubSDK): string {
  const agentId = sdk.agentId;
  if (agentId === undefined) {
    throw new Error("Workspace engagement listing requires a selected agent (sdk.agentId is unset)");
  }
  return agentId;
}

/**
 * List the signed-in human's Workspace conversation projection restricted to
 * chats where the SDK's agent is a speaker. The agent's organization is
 * resolved via `GET /agent/me`; the `with` filter runs server-side.
 */
export async function listWorkspaceChatsForAgent(
  sdk: FirstTreeHubSDK,
  options: { engagement: ChatEngagementView; limit?: number; cursor?: string },
): Promise<WorkspaceChatListResponse> {
  const agentId = requireSelectedAgentId(sdk);
  const organizationId = await sdk.getAgentOrganizationId();
  return sdk.listWorkspaceChats(organizationId, {
    engagement: options.engagement,
    withAgentId: agentId,
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
 * Read-only preflight immediately before `chat archive`: find the chat's
 * Workspace conversation row by paging the requested engagement view
 * (restricted to chats where the SDK's agent is a speaker), then merge that
 * row with the raw member chat detail.
 *
 * The Workspace row supplies the attention fields (`unreadMentionCount`,
 * `openRequestCount`, `liveActivity`, `failedAgentIds`, `busyAgentIds`,
 * `createdByMe`, `source`, `entityType`, `activityAt`, …); the detail — fetched
 * after the list lookup — supplies the raw `metadata` (where the SCM
 * entityKey/URL lives), `lastReadAt`, and the current-state
 * `engagementStatus` verdict. A chat whose engagement does not match the
 * requested view never appears in the paged list, and the detail re-check
 * covers the race between the list read and the archive. Anything else —
 * chat absent from the view, agent not a speaker, detail engagement drift —
 * yields an empty item list: the caller archives nothing.
 *
 * The scan is bounded and fails closed on abnormal pagination: a repeated
 * `nextCursor` (immediate repeat or a longer A→B→A cycle) or more than
 * {@link EXACT_SCAN_MAX_PAGES} pages throws instead of looping forever, so a
 * misbehaving server can never produce an archivable row nor reach the
 * detail read.
 */
export async function getWorkspaceChatExactForAgent(
  sdk: FirstTreeHubSDK,
  chatId: string,
  engagement: ChatEngagementView,
): Promise<WorkspaceChatExactListResponse> {
  const agentId = requireSelectedAgentId(sdk);
  const organizationId = await sdk.getAgentOrganizationId();

  let row: WorkspaceChatListItem | undefined;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageCount = 1; ; pageCount += 1) {
    const page = await sdk.listWorkspaceChats(organizationId, {
      engagement,
      withAgentId: agentId,
      limit: EXACT_SCAN_PAGE_SIZE,
      cursor,
    });
    row = page.items.find((item) => item.chatId === chatId);
    if (row !== undefined || page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `Workspace exact scan aborted: the server repeated pagination cursor "${page.nextCursor}" ` +
          `before chat ${chatId} was found. Failing closed — no archivable row, no detail read.`,
      );
    }
    seenCursors.add(page.nextCursor);
    if (pageCount >= EXACT_SCAN_MAX_PAGES) {
      throw new Error(
        `Workspace exact scan aborted: chat ${chatId} not found within ${EXACT_SCAN_MAX_PAGES} pages ` +
          `(page size ${EXACT_SCAN_PAGE_SIZE}). Failing closed — no archivable row, no detail read.`,
      );
    }
    cursor = page.nextCursor;
  }
  if (row === undefined) {
    return { items: [], nextCursor: null };
  }

  const detail = await sdk.getMemberChatDetail(chatId);
  const isSpeaker = detail.participants.some((participant) => participant.agentId === agentId);
  if (!isSpeaker || !engagementMatchesView(detail.engagementStatus, engagement)) {
    return { items: [], nextCursor: null };
  }

  const item: WorkspaceChatExactListItem = {
    ...row,
    id: chatId,
    chatId,
    metadata: detail.metadata,
    firstMessagePreview: detail.firstMessagePreview,
    viewerMembershipKind: detail.viewerMembershipKind,
    descriptionUpdatedAt: detail.descriptionUpdatedAt,
    lastReadAt: detail.lastReadAt,
    organizationId: detail.organizationId,
    lifecyclePolicy: detail.lifecyclePolicy,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    engagementStatus: detail.engagementStatus,
  };
  return { items: [item], nextCursor: null };
}
