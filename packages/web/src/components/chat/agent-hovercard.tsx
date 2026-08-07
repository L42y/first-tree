import type { AgentChatStatus } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { MessageSquarePlus, RotateCcw, Trash2, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { getAgent } from "../../api/agents.js";
import { getChat } from "../../api/chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { Avatar } from "../avatar.js";
import { HoverCard, type HoverCardPlacement } from "../ui/hover-card.js";
import { StatusGlyph } from "../ui/status-glyph.js";

/**
 * Shared participant identity hovercard. Wraps any trigger (avatar + name
 * cluster) and, on hover or activation, previews identity + one chat-scoped
 * status with full-row `New chat` / `View profile` routes. Durable profile and
 * runtime metadata stay on Agent Detail rather than turning this card into a
 * miniature inspector. A managing surface may additionally inject a
 * chat-session `Reset` action via `sessionReset`, and a speaker-owned
 * `removeFromChat` danger action; by default neither shows.
 *
 * Two-pass data (never blocks on a fetch):
 *  - Pass A (instant): identity + type/role from the chat participant list and
 *    live status from the chat agent-status — both already cached by ChatView.
 *  - Pass B (lazy on open): getAgent(agentId) verifies that Agent Detail is
 *    accessible and provides a fallback identity for non-chat entry points.
 *    The body only mounts when the card opens, so this query is naturally lazy.
 *
 * Known humans (`participantType="human"` or Pass A type) never request
 * `/agent-status`, skills, or getAgent — the card stays an identity surface.
 */
/**
 * Opt-in chat-session Reset action, injected by a managing surface (today:
 * the Participants roster row, which owns the confirm dialog + mutation).
 * The shared hovercard never decides eligibility itself — when the prop is
 * absent (chat-timeline triggers, unmanaged viewers, humans) no Reset shows.
 */
export type SessionResetAction = {
  /** Open the owner-rendered confirm dialog; the card closes itself first. */
  onRequest: () => void;
};

/** Opt-in Remove-from-chat danger action; confirm + mutation stay with the owner. */
export type RemoveFromChatAction = {
  /** Open the owner-rendered confirm dialog; the card closes itself first. */
  onRequest: () => void;
};

export type ParticipantTypeHint = "human" | "agent";

/** Accessible name for the card danger Remove control (shared with roster tests). */
export function removeFromChatAriaLabel(displayName: string): string {
  return `Remove ${displayName} from this chat`;
}

export function AgentHovercard({
  agentId,
  chatId,
  name,
  placement = "bottom",
  triggerClassName,
  participantType,
  sessionReset,
  removeFromChat,
  children,
}: {
  agentId: string;
  chatId: string;
  /**
   * Display name of the target, for the trigger's accessible label. Required so
   * each trigger announces a distinct name — without it the fixed label would
   * override the visible name text and read identically for every agent.
   */
  name: string;
  placement?: HoverCardPlacement;
  triggerClassName?: string;
  /** When known, skips agent-status / getAgent for humans before Pass A resolves. */
  participantType?: ParticipantTypeHint;
  sessionReset?: SessionResetAction;
  removeFromChat?: RemoveFromChatAction;
  children: ReactNode;
}) {
  return (
    <HoverCard
      placement={placement}
      ariaLabel={`Show details for ${name}`}
      triggerClassName={triggerClassName}
      // Card chrome (background / border / shadow / padding) comes from the
      // HoverCard primitive; only the width is this consumer's call.
      contentStyle={{
        width: 280,
        maxWidth: "calc(100vw - var(--sp-4))",
      }}
      content={({ close }) => (
        <AgentHovercardBody
          agentId={agentId}
          chatId={chatId}
          participantType={participantType}
          sessionReset={sessionReset}
          removeFromChat={removeFromChat}
          onAction={close}
        />
      )}
    >
      {children}
    </HoverCard>
  );
}

function AgentHovercardBody({
  agentId,
  chatId,
  participantType,
  sessionReset,
  removeFromChat,
  onAction,
}: {
  agentId: string;
  chatId: string;
  participantType?: ParticipantTypeHint;
  sessionReset?: SessionResetAction;
  removeFromChat?: RemoveFromChatAction;
  onAction: () => void;
}) {
  const { agentId: myAgentId } = useAuth();

  // Pass A — cached by ChatView, so these are hits (instant). staleTime keeps a
  // warm cache from refetching on every card open: scanning many names in a busy
  // timeline/sidebar would otherwise fire a GET /chats/:id + /agent-status per
  // hover. ChatView's own observers (agent-status refetchInterval + WS
  // invalidation) keep the data fresh; the card only needs to read it.
  const chatQ = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    staleTime: 30_000,
  });

  const participant = chatQ.data?.participants.find((p) => p.agentId === agentId);
  const knownHuman = participantType === "human" || (participantType !== "agent" && participant?.type === "human");
  const statusQueryEnabled =
    participantType === "human"
      ? false
      : participantType === "agent"
        ? true
        : chatQ.isSuccess && participant?.type !== "human";

  const statusQ = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    staleTime: 30_000,
    enabled: statusQueryEnabled,
  });

  const status: AgentChatStatus | null = statusQ.data?.find((s) => s.agentId === agentId) ?? null;

  // Pass B — lazy: this body only mounts while the card is open. Gated on the
  // chat (Pass A) resolving so the human check is decided from real data —
  // otherwise a cold-cache open would fire getAgent before we know the type and
  // 404 on a human. In practice ChatView keeps Pass A warm, so this is instant.
  const agentQ = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => getAgent(agentId),
    enabled: !knownHuman && chatQ.isSuccess && participant?.type !== "human",
    staleTime: 30_000,
  });

  const isHuman = knownHuman || (participant?.type ?? agentQ.data?.type) === "human";
  const isSelf = isHuman && agentId === myAgentId;
  const displayName = participant?.displayName ?? agentQ.data?.displayName ?? "…";
  const handle = participant?.name ?? agentQ.data?.name ?? null;
  const avatarImageUrl = participant?.avatarImageUrl ?? agentQ.data?.avatarImageUrl ?? null;
  const avatarColorToken = participant?.avatarColorToken ?? agentQ.data?.avatarColorToken ?? null;

  const statusView = !isHuman && status ? viewOf(status.main) : null;
  // Pass B 404s for a private agent visible only via chat membership (getAgent +
  // the agent-detail route are both visibility-gated). When that happens, hide
  // the View profile route rather than send the viewer to a page they can't open.
  // Do not expose a route before the lazy permission probe succeeds. Private
  // participants and transient failures both keep the always-valid chat route;
  // the card never flashes an action that may immediately land on a 404.
  const detailsAccessible = agentQ.isSuccess;
  const chatPath = `/?c=draft&with=${encodeURIComponent(agentId)}`;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
      {/* Head — 40px avatar, name, optional @handle, kind/status on the right */}
      <div className="flex items-center" style={{ gap: "var(--sp-2_5)" }}>
        <span className="shrink-0" style={{ width: "var(--sp-10)", height: "var(--sp-10)" }}>
          <Avatar src={avatarImageUrl} name={displayName} seed={agentId} colorToken={avatarColorToken} size={40} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 1 }}>
          <div
            className="text-subtitle"
            title={displayName}
            style={{
              color: "var(--fg)",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
              overflowWrap: "anywhere",
            }}
          >
            {displayName}
          </div>
          {handle ? (
            <div className="mono text-label truncate" style={{ color: "var(--fg-2)" }} title={`@${handle}`}>
              @{handle}
            </div>
          ) : null}
        </div>
        <ParticipantKind isHuman={isHuman} isSelf={isSelf} statusView={statusView} />
      </div>

      {/* Ordinary actions stay above a hairline danger zone. A human viewing
          their own identity gets no dead-end self-chat action and no Remove. */}
      {isSelf ? null : (
        <ParticipantActions
          displayName={displayName}
          chatPath={chatPath}
          profilePath={!isHuman && detailsAccessible ? `/agents/${agentId}/profile` : null}
          sessionReset={!isHuman ? sessionReset : undefined}
          removeFromChat={removeFromChat}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function ParticipantKind({
  isHuman,
  isSelf,
  statusView,
}: {
  isHuman: boolean;
  isSelf: boolean;
  statusView: ReturnType<typeof viewOf> | null;
}) {
  if (isHuman) {
    return (
      <span className="text-label shrink-0" style={{ color: "var(--fg-2)" }}>
        {isSelf ? "You" : "Human"}
      </span>
    );
  }
  if (!statusView) {
    return (
      <span className="text-label shrink-0" style={{ color: "var(--fg-2)" }}>
        Agent
      </span>
    );
  }
  return (
    <span
      className="text-label inline-flex shrink-0 items-center"
      style={{ gap: "var(--sp-1_5)", color: "var(--fg-2)" }}
    >
      <StatusGlyph colorVar={statusView.colorVar} shape={statusView.shape} pulse={statusView.pulse} size={7} />
      {statusView.label}
    </span>
  );
}

function ParticipantActions({
  displayName,
  chatPath,
  profilePath,
  sessionReset,
  removeFromChat,
  onAction,
}: {
  displayName: string;
  chatPath: string;
  profilePath: string | null;
  sessionReset?: SessionResetAction;
  removeFromChat?: RemoveFromChatAction;
  onAction: () => void;
}) {
  const rowClass =
    "text-label flex w-full min-h-8 items-center gap-2 rounded-[var(--radius-input)] px-2 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring active:bg-[var(--bg-active)]";
  const dangerClass =
    "text-label flex w-full min-h-8 items-center gap-2 rounded-[var(--radius-input)] px-2 transition-colors hover:bg-[var(--bg-error-soft)] hover:text-[var(--fg-error-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fg-error-strong)] active:bg-[var(--bg-error-soft)]";

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
      <nav aria-label="Participant actions" className="flex flex-col" data-participant-actions style={{ gap: 2 }}>
        <Link to={chatPath} onClick={onAction} className={rowClass} style={{ color: "var(--fg-2)" }}>
          <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">New chat</span>
        </Link>
        {profilePath ? (
          <Link to={profilePath} onClick={onAction} className={rowClass} style={{ color: "var(--fg-2)" }}>
            <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">View profile</span>
          </Link>
        ) : null}
        {sessionReset ? (
          <button
            type="button"
            aria-label="Reset session"
            title="Reset this agent's session in this chat"
            onClick={() => {
              // The row-owned confirm dialog replaces the card — close first so
              // no floating card lingers above the modal.
              onAction();
              sessionReset.onRequest();
            }}
            className={rowClass}
            style={{ color: "var(--fg-2)" }}
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Reset</span>
          </button>
        ) : null}
      </nav>

      {removeFromChat ? (
        <div
          data-participant-danger
          style={{ borderTop: "var(--hairline) solid var(--border-faint)", paddingTop: "var(--sp-1)" }}
        >
          <button
            type="button"
            aria-label={removeFromChatAriaLabel(displayName)}
            title="Remove from this chat"
            onClick={() => {
              onAction();
              removeFromChat.onRequest();
            }}
            className={dangerClass}
            style={{ color: "var(--fg-3)" }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Remove from chat</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
