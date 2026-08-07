import { type ChatParticipantDetail, REMOVE_PARTICIPANT_OPEN_REQUEST_CODE } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { removeMeChatParticipant } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { AddParticipantDropdown } from "../../../components/add-participant-dropdown.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import { AgentStatusPanel } from "../../../components/chat/agent-status-panel.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";
import { useToast } from "../../../components/ui/toast.js";

/** Roster rows shown before the "Show all" fold. The rail is a calm
 *  inspection surface, not a member-management screen — a long roster
 *  shouldn't push Description / GitHub off-screen, so we cap the visible
 *  rows and tuck the rest behind a toggle. */
export const VISIBLE_LIMIT = 5;

/**
 * Order the roster agents-first (their live status is the glanceable pulse),
 * then humans, preserving server order within each group; cap to `limit`
 * unless `showAll`. Pure so the ordering / fold math is unit-testable without
 * rendering the query-backed AgentStatusPanel.
 */
export function partitionRoster(
  participants: ChatParticipantDetail[],
  showAll: boolean,
  limit: number = VISIBLE_LIMIT,
): {
  total: number;
  visibleAgents: ChatParticipantDetail[];
  visibleHumans: ChatParticipantDetail[];
  hiddenCount: number;
} {
  const agents = participants.filter((p) => p.type !== "human");
  const humans = participants.filter((p) => p.type === "human");
  const ordered = [...agents, ...humans];
  const total = ordered.length;
  const visible = showAll ? ordered : ordered.slice(0, limit);
  return {
    total,
    visibleAgents: visible.filter((p) => p.type !== "human"),
    visibleHumans: visible.filter((p) => p.type === "human"),
    hiddenCount: total - visible.length,
  };
}

/**
 * Best-effort Web affordance for the owner-side / own-agent removal matrix.
 * Server remains the authority; this only hides controls the roster +
 * `managedByMe` map can prove are disallowed. Owner rows are never removable.
 * When the owner speaker is absent from the roster (watcher owner), only
 * own-agent recalls remain visible.
 */
export function canRequestRemoveParticipant(input: {
  selfAgentId: string | null | undefined;
  target: ChatParticipantDetail;
  participants: ChatParticipantDetail[];
  managedByMe: Map<string, boolean>;
}): boolean {
  const { selfAgentId, target, participants, managedByMe } = input;
  if (!selfAgentId || target.agentId === selfAgentId) return false;
  if (target.role === "owner") return false;
  const selfRow = participants.find((p) => p.agentId === selfAgentId);
  if (!selfRow) return false;
  const ownerRow = participants.find((p) => p.role === "owner");
  const ownerSide = selfRow.role === "owner" || Boolean(ownerRow && (managedByMe.get(ownerRow.agentId) ?? false));
  if (ownerSide) return true;
  return target.type !== "human" && (managedByMe.get(target.agentId) ?? false);
}

/**
 * Participants section — full chat membership (humans + agents), the top
 * section of the rail. Speakers other than the current user expose a Remove
 * action when the owner-side / own-agent matrix allows; watchers / read-only /
 * self / owners do not.
 */
export function ParticipantsSection({
  chatId,
  participants,
  participantsLoading,
  managedByMe,
  onAdded,
  readOnly,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  onAdded: () => void;
  readOnly: boolean;
}) {
  const { role, agentId: selfAgentId } = useAuth();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<ChatParticipantDetail | null>(null);

  const isAdmin = role === "admin";
  // Chat detail participants are speakers-only. Supervisors who can open the
  // chat without membership must not see Remove — the server still 403s them.
  const selfIsSpeaker = Boolean(selfAgentId && participants.some((p) => p.agentId === selfAgentId));
  const canRemoveSpeakers = !readOnly && selfIsSpeaker;
  const { total, visibleAgents, visibleHumans, hiddenCount } = useMemo(
    () => partitionRoster(participants, showAll),
    [participants, showAll],
  );

  const allowRemove = (target: ChatParticipantDetail): boolean =>
    canRemoveSpeakers && canRequestRemoveParticipant({ selfAgentId, target, participants, managedByMe });

  const removeMut = useMutation({
    mutationFn: (target: ChatParticipantDetail) => removeMeChatParticipant(chatId, target.agentId),
    onSuccess: (result, target) => {
      setPendingRemove(null);
      void queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      void queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      void queryClient.invalidateQueries({ queryKey: ["chat-agent-status", chatId] });
      void queryClient.invalidateQueries({ queryKey: ["chat-right-sidebar", "cron-jobs", chatId] });
      if (result.membershipKind === "watching") {
        addToast({
          title: "Moved to watching",
          description: `${target.displayName} was removed as a participant but can still observe this chat because they manage an agent here.`,
        });
      } else {
        addToast({
          title: "Participant removed",
          description: `${target.displayName} can no longer send messages or be @mentioned in this chat.`,
        });
      }
      onAdded();
    },
    onError: (error) => {
      const openRequest =
        error instanceof ApiError && (error.code === REMOVE_PARTICIPANT_OPEN_REQUEST_CODE || error.status === 409);
      addToast({
        title: openRequest ? "Unanswered request" : "Could not remove participant",
        description: openRequest
          ? error instanceof Error
            ? error.message
            : "Answer or skip the open request before removing this person."
          : error instanceof Error
            ? error.message
            : "Something went wrong. Try again.",
      });
    },
  });

  const requestRemove = (target: ChatParticipantDetail): void => {
    if (!allowRemove(target)) return;
    setPendingRemove(target);
  };

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Participants <span className="mono">· {total}</span>
      </div>

      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-1)", gap: 2 }}>
        {participantsLoading ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : total === 0 ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            No participants yet.
          </div>
        ) : (
          <>
            {visibleAgents.length > 0 ? (
              <AgentStatusPanel
                chatId={chatId}
                agents={visibleAgents}
                canManage={(id) => isAdmin || (managedByMe.get(id) ?? false)}
                compact
                onRequestRemove={canRemoveSpeakers ? requestRemove : undefined}
                canRemoveAgent={allowRemove}
                selfAgentId={selfAgentId}
              />
            ) : null}
            {visibleHumans.map((p) => (
              <HumanRow
                key={p.agentId}
                participant={p}
                canRemove={allowRemove(p)}
                onRequestRemove={() => requestRemove(p)}
              />
            ))}
            {hiddenCount > 0 ? (
              <RosterToggle onClick={() => setShowAll(true)}>Show all · {total}</RosterToggle>
            ) : showAll && total > VISIBLE_LIMIT ? (
              <RosterToggle onClick={() => setShowAll(false)}>Show less</RosterToggle>
            ) : null}
          </>
        )}
      </div>

      {readOnly ? null : (
        <div style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-2)" }}>
          <AddParticipantDropdown
            variant="inline"
            chatId={chatId}
            participantIds={participants.map((p) => p.agentId)}
            onAdded={onAdded}
          />
        </div>
      )}

      <RemoveParticipantConfirmDialog
        open={pendingRemove !== null}
        participant={pendingRemove}
        pending={removeMut.isPending}
        onOpenChange={(open) => {
          if (!open && !removeMut.isPending) setPendingRemove(null);
        }}
        onConfirm={() => {
          if (pendingRemove && !removeMut.isPending) removeMut.mutate(pendingRemove);
        }}
      />
    </section>
  );
}

function RosterToggle({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-caption w-full text-left transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
      style={{ padding: "var(--sp-1_5) var(--sp-2)", color: "var(--fg-3)", borderRadius: "var(--radius-input)" }}
    >
      {children}
    </button>
  );
}

function HumanRow({
  participant,
  canRemove,
  onRequestRemove,
}: {
  participant: ChatParticipantDetail;
  canRemove: boolean;
  onRequestRemove: () => void;
}) {
  const actions: RowAction[] = canRemove
    ? [{ key: "remove", label: "Remove from chat", destructive: true, onSelect: onRequestRemove }]
    : [];

  return (
    <div
      className="group flex items-center"
      style={{
        gap: "var(--sp-2_5)",
        padding: "var(--sp-1_25) var(--sp-2)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <RealAvatar
        src={participant.avatarImageUrl}
        name={participant.displayName}
        seed={participant.agentId}
        colorToken={participant.avatarColorToken}
        size={28}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{participant.displayName}</div>
      </div>
      {actions.length > 0 ? (
        <RowActionsMenu actions={actions} ariaLabel={`Actions for ${participant.displayName}`} />
      ) : null}
    </div>
  );
}

export function RemoveParticipantConfirmDialog({
  open,
  participant,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  participant: ChatParticipantDetail | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const label = participant?.displayName ?? "this participant";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {label}?</DialogTitle>
          <DialogDescription>
            They will be removed as a participant of this chat only. They will no longer be able to send messages or be
            @mentioned here. If they still manage an agent in this chat, they may continue to observe as a watcher.
            Message history is kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
