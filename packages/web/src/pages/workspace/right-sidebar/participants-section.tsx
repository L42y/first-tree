import type { ChatParticipantDetail } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
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
 * Participants section — full chat membership (humans + agents), the top
 * section of the rail. Agents render first (their live status is the
 * glanceable pulse) through <AgentStatusPanel> (one
 * /chats/:id/agent-status call drives every agent's composite status +
 * per-row Pause when the caller can manage). Humans follow as a simplified
 * roster. Only a viewer who is themselves a speaker in the passed roster
 * (and not read-only) can Remove any other speaker; supervisor-only views
 * must not show Remove. Self-removal stays on Leave.
 *
 * The roster is capped at VISIBLE_LIMIT; the remainder collapses behind a
 * "Show all" toggle so a crowded chat can't dominate the rail.
 *
 * The bottom "Add" affordance shares <AddParticipantDropdown> with the
 * header quick-add icon — both go through the same `addMeChatParticipants`
 * mutation and the same grouped, avatar'd picker.
 *
 * Membership data (`participants` / `managedByMe`) is passed down from
 * ChatView, which already holds the `chat-detail` + `activity` queries.
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
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ChatParticipantDetail | null>(null);
  // Decouple dialog open from target so a successful close can start the exit
  // animation without clearing the title to `Remove ""?` mid-transition.
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeDialogLabel, setRemoveDialogLabel] = useState("");

  const isAdmin = role === "admin";
  const { total, visibleAgents, visibleHumans, hiddenCount } = useMemo(
    () => partitionRoster(participants, showAll),
    [participants, showAll],
  );

  // Gate on speaker membership in the roster props — not org role / managedByMe.
  // Supervisor views (`viewerMembershipKind === null`) still have a selfAgentId
  // and may leave `readOnly` false, but they are absent from `participants`.
  const selfIsSpeaker = Boolean(selfAgentId && participants.some((p) => p.agentId === selfAgentId));
  const canRemoveOthers = !readOnly && selfIsSpeaker;
  const canRemove = (agentId: string) => canRemoveOthers && agentId !== selfAgentId;

  const openRemoveDialog = (target: ChatParticipantDetail) => {
    setRemoveTarget(target);
    setRemoveDialogLabel(target.displayName);
    setRemoveDialogOpen(true);
  };

  const closeRemoveDialog = () => {
    setRemoveDialogOpen(false);
    setRemoveTarget(null);
    // Keep `removeDialogLabel` through the exit animation (and after Cancel).
    // The next `openRemoveDialog` overwrites it; an empty string must never
    // drive the title while DialogContent is still mounted.
  };

  const removeMut = useMutation({
    mutationFn: (target: ChatParticipantDetail) => removeMeChatParticipant(chatId, target.agentId),
    onSuccess: (_data, target) => {
      // Close the dialog and drop the actionable target immediately so a second
      // Confirm during Radix exit presence cannot re-fire DELETE. Keep only the
      // display label for the ~200ms close animation (never `Remove ""?`).
      setRemoveDialogOpen(false);
      setRemoveTarget(null);
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onAdded();
      addToast({
        title: "Participant removed",
        description: `${target.displayName} can no longer participate or be addressed in this chat. Existing messages are kept.`,
      });
    },
    onError: (error) => {
      addToast({
        title: "Couldn't remove participant",
        description: error instanceof Error ? error.message : "Something went wrong. Try again.",
      });
    },
  });

  // Confirm stays inert once the actionable target is cleared (post-success exit).
  const removeConfirmLocked = removeMut.isPending || removeTarget === null;

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
                canRemove={canRemove}
                onRemove={openRemoveDialog}
                compact
              />
            ) : null}
            {visibleHumans.map((p) => (
              <HumanRow
                key={p.agentId}
                participant={p}
                showRemove={canRemove(p.agentId)}
                onRemove={() => openRemoveDialog(p)}
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
        open={removeDialogOpen}
        onOpenChange={(open) => {
          if (!open && !removeMut.isPending) closeRemoveDialog();
        }}
        label={removeDialogLabel}
        onConfirm={() => {
          if (!removeTarget || removeMut.isPending) return;
          removeMut.mutate(removeTarget);
        }}
        pending={removeMut.isPending}
        locked={removeConfirmLocked}
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
  showRemove,
  onRemove,
}: {
  participant: ChatParticipantDetail;
  showRemove: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className="flex items-center"
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
      {showRemove ? <RemoveButton displayName={participant.displayName} onClick={onRemove} /> : null}
    </div>
  );
}

/** Unique accessible name shared by human and agent Remove controls. */
export function removeParticipantAriaLabel(displayName: string): string {
  return `Remove ${displayName} from this chat`;
}

export function RemoveButton({
  displayName,
  onClick,
  disabled = false,
}: {
  displayName: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={removeParticipantAriaLabel(displayName)}
      title="Remove from this chat"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-error-soft)] hover:text-[var(--fg-error-strong)] hover:border-[var(--fg-error-strong)] disabled:opacity-50"
      style={{
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: "transparent",
        color: "var(--fg-3)",
      }}
    >
      Remove
    </button>
  );
}

function RemoveParticipantConfirmDialog({
  open,
  onOpenChange,
  label,
  onConfirm,
  pending,
  locked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onConfirm: () => void;
  pending: boolean;
  /** True while mutating or once the actionable target has been cleared. */
  locked: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove "{label}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DialogDescription style={{ color: "var(--fg-2)" }}>
            They will no longer participate or be addressable in this chat.
          </DialogDescription>
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            Existing messages stay in the history. They may still see the chat if watcher access remains.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={locked}
            aria-label={pending ? "Removing participant" : "Confirm remove participant"}
          >
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
