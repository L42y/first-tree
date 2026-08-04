import type {
  ContextTreeNode,
  ContextTreeSnapshot,
  ContextTreeUpdate,
  GithubEventCard,
  MeChatRow,
} from "@first-tree/shared";
import { ChevronDown, Filter, ListTree, PanelRight, Paperclip, Plus, Send, UserPlus, Users } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Avatar } from "../components/avatar.js";
import { ActivityDots } from "../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../components/chat/chat-row-avatar.js";
import { GithubEventCardMessage, GithubSystemAvatar } from "../components/chat/github-event-card.js";
import { Button } from "../components/ui/button.js";
import { StatusGlyph } from "../components/ui/status-glyph.js";
import { ContextPage } from "./context.js";
import { MOCK_CONTEXT_SNAPSHOT } from "./context-preview-mock.js";

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function progress(time: number, start: number, end: number): number {
  return clamp((time - start) / (end - start));
}

function ease(value: number): number {
  return 1 - (1 - value) ** 3;
}

function enterStyle(value: number, offset = 0.8): CSSProperties {
  const amount = ease(clamp(value));
  return {
    opacity: amount,
    transform: `translateY(${(1 - amount) * offset}rem)`,
  };
}

export function contextTreeUsesWorkspace(time: number): boolean {
  return time < 5 || (time >= 12 && time < 47) || time >= 55;
}

export function ContextTreeOrientationScene({ time }: { time: number }) {
  const firstContextOpacity = Math.min(progress(time, 4.7, 5.3), 1 - progress(time, 11.5, 12.1));
  const finalContextOpacity = Math.min(progress(time, 46.7, 47.3), 1 - progress(time, 54.5, 55.1));
  const contextOpacity = Math.max(firstContextOpacity, finalContextOpacity);
  const workspaceOpacity = 1 - contextOpacity;
  const finalContext = time >= 46.7;
  const contextSnapshot = contextVideoSnapshot(finalContext);
  const recipient = time < 30 ? "Nova" : time < 55 ? "context-reviewer" : "forge-dev";
  const contextPan = finalContext ? ease(progress(time, 51, 52.2)) * 410 : ease(progress(time, 7, 8.5)) * 410;

  return (
    <div className="relative h-[calc(100vh-3rem)] min-h-0 overflow-hidden bg-background">
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ opacity: contextOpacity, pointerEvents: "none", transition: "none" }}
      >
        <div
          className="mx-auto w-full p-6"
          style={{ maxWidth: 1100, transform: `translateY(-${contextPan}px)`, transition: "none" }}
        >
          <ContextPage key={finalContext ? "updated" : "baseline"} previewSnapshot={contextSnapshot} />
        </div>
      </div>
      <div
        className="absolute inset-0 flex min-h-0"
        style={{ opacity: workspaceOpacity, pointerEvents: "none", transition: "none" }}
      >
        <ContextConversationRail time={time} />
        <main className="relative flex min-w-0 flex-1 flex-col bg-background">
          <ContextChatHeader time={time} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <ContextTreeChatScene time={time} />
          </div>
          <ContextComposer recipient={recipient} />
        </main>
        <ContextRightSidebar time={time} />
      </div>
    </div>
  );
}

function ContextChatHeader({ time }: { time: number }) {
  const title =
    time < 30
      ? "Prevent duplicate checkout charges"
      : time < 55
        ? "Review Context update"
        : "Add mobile checkout retries";
  return (
    <header className="flex min-h-12 shrink-0 items-center bg-bg-raised px-6 py-1.5">
      <p className="min-w-0 flex-1 truncate text-subtitle font-semibold">{title}</p>
      <div className="flex items-center text-fg-3" style={{ gap: "var(--sp-1)" }}>
        <Users size={15} />
        <span className="mono text-caption">2</span>
        <UserPlus size={16} className="ml-2" />
        <PanelRight size={17} className="ml-2 text-foreground" />
      </div>
    </header>
  );
}

const WORK_PARTICIPANTS: MeChatRow["participants"] = [
  { agentId: "human-gandy", displayName: "Gandy", type: "human", avatarColorToken: null, avatarImageUrl: null },
  { agentId: "nova-lead", displayName: "nova-lead", type: "agent", avatarColorToken: "hue-2", avatarImageUrl: null },
];

const REVIEW_PARTICIPANTS: MeChatRow["participants"] = [
  { agentId: "human-gandy", displayName: "Gandy", type: "human", avatarColorToken: null, avatarImageUrl: null },
  {
    agentId: "context-reviewer",
    displayName: "context-reviewer",
    type: "agent",
    avatarColorToken: "hue-1",
    avatarImageUrl: null,
  },
];

const NEXT_TASK_PARTICIPANTS: MeChatRow["participants"] = [
  { agentId: "human-gandy", displayName: "Gandy", type: "human", avatarColorToken: null, avatarImageUrl: null },
  { agentId: "forge-dev", displayName: "forge-dev", type: "agent", avatarColorToken: "hue-6", avatarImageUrl: null },
];

function ContextConversationRail({ time }: { time: number }) {
  const workSelected = time < 30;
  const reviewSelected = time >= 30 && time < 55;
  return (
    <aside className="flex w-70 shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised">
      <ContextConversationRailHeader itemCount={time < 30 ? 1 : time < 55 ? 2 : 3} />
      <ContextRailItem
        title="Prevent duplicate checkout charges"
        participants={WORK_PARTICIPANTS}
        selected={workSelected}
        timeLabel={workSelected ? undefined : "8m"}
        working={workSelected && time < 28.5}
      />
      {time >= 30 ? (
        <ContextRailItem
          title="Review Context update"
          participants={REVIEW_PARTICIPANTS}
          selected={reviewSelected}
          working={reviewSelected && time < 45.5}
          timeLabel={reviewSelected ? undefined : "3m"}
        />
      ) : null}
      {time >= 55 ? (
        <ContextRailItem
          title="Add mobile checkout retries"
          participants={NEXT_TASK_PARTICIPANTS}
          selected={!workSelected && !reviewSelected}
          working={time < 59}
        />
      ) : null}
    </aside>
  );
}

function ContextConversationRailHeader({ itemCount }: { itemCount: number }) {
  return (
    <div className="shrink-0 flex flex-col border-b border-border-faint">
      <div className="flex items-center px-3 py-2.5" style={{ gap: "var(--sp-1)" }}>
        <Button type="button" variant="cta" size="xs" className="text-body">
          <Plus size={14} strokeWidth={2} />
          <span>New chat</span>
        </Button>
        <span className="ml-auto" />
        <button type="button" aria-label="Filter" className="inline-flex items-center px-1.5 py-0.5 text-fg-3">
          <Filter size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex items-center px-3 pb-2.5">
        <div className="flex items-center" style={{ gap: 2 }}>
          <span className="rounded bg-bg-active px-1.5 py-0.5 text-label text-foreground">All</span>
          <span className="px-1.5 py-0.5 text-label text-fg-3">Unread</span>
          <span className="px-1.5 py-0.5 text-label text-fg-3">Watching</span>
        </div>
        <span className="ml-auto flex items-center text-label text-fg-2" style={{ gap: 4 }}>
          <ListTree size={13} strokeWidth={1.75} className="text-fg-4" /> Recent <ChevronDown size={12} />
        </span>
      </div>
      <div className="flex items-center px-3 pb-0.5 pt-1.5 text-eyebrow uppercase text-fg-4" style={{ gap: 4 }}>
        <ChevronDown size={10} /> Today <span className="mono font-normal">{itemCount}</span>
      </div>
    </div>
  );
}

function ContextRailItem({
  title,
  participants,
  selected,
  working,
  timeLabel,
}: {
  title: string;
  participants: MeChatRow["participants"];
  selected: boolean;
  working: boolean;
  timeLabel?: string;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center text-left"
      style={{
        padding: "var(--sp-2) var(--sp-3)",
        gap: "var(--sp-2)",
        background: selected ? "var(--brand-bg)" : "transparent",
        borderLeft: `var(--hairline-bold) solid ${selected ? "var(--brand)" : "transparent"}`,
      }}
    >
      <ChatRowAvatar
        title={title}
        type="direct"
        participants={participants}
        selfAgentId="human-gandy"
        unreadCount={0}
        size={26}
        muted
        badge={false}
        statusDot
      />
      <span
        className="min-w-0 flex-1 truncate text-subtitle font-medium"
        style={{ color: selected ? "var(--fg)" : "var(--fg-2)" }}
      >
        {title}
      </span>
      <span className="shrink-0">
        {working ? <ActivityDots /> : <span className="mono text-caption text-fg-4">{timeLabel}</span>}
      </span>
    </button>
  );
}

const CONTEXT_VIDEO_NOW = "2099-01-01T12:00:00.000Z";

function contextVideoNode(
  id: string,
  parentId: string | null,
  path: string,
  title: string,
  kind: ContextTreeNode["kind"],
  changeType: ContextTreeNode["changeType"],
): ContextTreeNode {
  return {
    id,
    parentId,
    path,
    sourcePath: kind === "leaf" ? `${path.replace(/^\//, "")}.md` : null,
    title,
    kind,
    owners: id.startsWith("system/billing") ? ["billing-platform"] : [],
    preview: changeType ? `Settled team context for ${title}.` : null,
    relatedNodeIds: [],
    affectedContextArea: title,
    changeType,
    changedAtCommit: changeType ? "8a42c1f" : null,
  };
}

function contextVideoUpdate(
  id: string,
  nodeId: string,
  path: string,
  title: string,
  changeType: ContextTreeUpdate["changeType"],
  affectedContextArea: string,
): ContextTreeUpdate {
  return {
    id,
    nodeId,
    path,
    title,
    changeType,
    affectedContextArea,
    reason: "Settled team decision",
    summary: "Recorded retry ownership and rationale for future agents.",
    changedBy: "nova-lead",
    owners: ["billing-platform"],
    relatedNodeIds: [],
    sourceCommit: "8a42c1f0",
    riskLevel: "low",
  };
}

function contextVideoNodes(updated: boolean): ContextTreeNode[] {
  return [
    contextVideoNode("root", null, "/", "Context Tree", "root", null),
    contextVideoNode("system", "root", "/system", "System", "domain", "edited"),
    contextVideoNode("system/billing", "system", "/system/billing", "Billing", "subdomain", "edited"),
    ...(updated
      ? [
          contextVideoNode(
            "system/billing/retry-ownership",
            "system/billing",
            "/system/billing/retry-ownership",
            "Billing retry ownership",
            "leaf",
            "added",
          ),
        ]
      : []),
    contextVideoNode("security", "root", "/security", "Security", "domain", "edited"),
    contextVideoNode("security/auth", "security", "/security/auth", "Auth boundary", "leaf", "edited"),
    contextVideoNode("decisions", "root", "/decisions", "Decisions", "domain", "edited"),
    contextVideoNode("decisions/adr-019", "decisions", "/decisions/adr-019", "ADR-019", "leaf", "added"),
  ];
}

const CONTEXT_BASELINE_UPDATES: ContextTreeUpdate[] = [
  contextVideoUpdate(
    "update-adr-019",
    "decisions/adr-019",
    "/decisions/adr-019",
    "ADR-019",
    "added",
    "decisions / architecture",
  ),
  contextVideoUpdate(
    "update-auth-boundary",
    "security/auth",
    "/security/auth",
    "Auth boundary",
    "edited",
    "security / authentication",
  ),
  contextVideoUpdate("update-billing", "system/billing", "/system/billing", "Billing", "edited", "system / billing"),
];

const CONTEXT_RETRY_UPDATE: ContextTreeUpdate = contextVideoUpdate(
  "update-billing-ownership",
  "system/billing/retry-ownership",
  "/system/billing/retry-ownership",
  "Billing retry ownership",
  "added",
  "system / billing / ownership",
);

function contextReadEvent(
  id: string,
  targetPath: string,
  agent: { id: string; name: string; hue: string; provider: "claude-code" | "codex" },
  chat: { id: string; title: string },
): ContextTreeSnapshot["io"]["recentEvents"][number] {
  return {
    id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatarColorToken: agent.hue,
    runtimeProvider: agent.provider,
    action: "read",
    source: "shell_command",
    targetKind: "file",
    targetPath,
    chatId: chat.id,
    chatTitle: chat.title,
    viewerCanAccess: true,
    createdAt: CONTEXT_VIDEO_NOW,
  };
}

const BILLING_AGENT = { id: "nova-lead", name: "nova-lead", hue: "hue-2", provider: "claude-code" } as const;
const REVIEW_AGENT = {
  id: "context-reviewer",
  name: "context-reviewer",
  hue: "hue-1",
  provider: "codex",
} as const;
const BILLING_CHAT = { id: "prevent-duplicate-charges", title: "Prevent duplicate checkout charges" } as const;
const REVIEW_CHAT = { id: "review-context-update", title: "Review Context update" } as const;

function contextVideoSnapshot(updated: boolean): ContextTreeSnapshot {
  const reads: ContextTreeSnapshot["io"]["recentEvents"] = [
    contextReadEvent("read-billing", "system/billing/NODE.md", BILLING_AGENT, BILLING_CHAT),
    contextReadEvent("read-auth", "security/auth.md", BILLING_AGENT, BILLING_CHAT),
    contextReadEvent("read-adr", "decisions/adr-019.md", BILLING_AGENT, BILLING_CHAT),
    ...(updated
      ? [contextReadEvent("read-review", "system/billing/retry-ownership.md", REVIEW_AGENT, REVIEW_CHAT)]
      : []),
  ];
  return {
    ...MOCK_CONTEXT_SNAPSHOT,
    repo: "acme-team/context-tree",
    branch: "main",
    headCommit: "8a42c1f0",
    syncedAt: CONTEXT_VIDEO_NOW,
    summary: updated
      ? { addedCount: 2, editedCount: 5, removedCount: 0, changedNodeCount: 7 }
      : { addedCount: 1, editedCount: 5, removedCount: 0, changedNodeCount: 6 },
    nodes: contextVideoNodes(updated),
    updates: updated ? [CONTEXT_RETRY_UPDATE, ...CONTEXT_BASELINE_UPDATES] : CONTEXT_BASELINE_UPDATES,
    edges: [],
    changes: [],
    io: {
      ...MOCK_CONTEXT_SNAPSHOT.io,
      summary: {
        read: { agentCount: updated ? 2 : 1, eventCount: reads.length, targetCount: reads.length },
        write: { agentCount: updated ? 1 : 0, eventCount: updated ? 1 : 0, targetCount: updated ? 1 : 0 },
      },
      recentEvents: reads,
      agents: [],
      writes: updated
        ? [
            {
              id: `${"8".repeat(40)}:system/billing/retry-ownership.md`,
              nodeId: "system/billing/retry-ownership",
              nodePath: "system/billing/retry-ownership",
              title: "Billing retry ownership",
              changeType: "added",
              summary: "record retry ownership and rationale",
              riskLevel: "low",
              authorName: "nova-lead",
              agentId: "nova-lead",
              agentName: "nova-lead",
              agentAvatarColorToken: "hue-2",
              commit: "8".repeat(40),
              prNumber: 742,
              createdAt: CONTEXT_VIDEO_NOW,
            },
          ]
        : [],
      writesTotal: updated ? 1 : 0,
      skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
    },
  };
}

const CONTEXT_WORK_PR_NUMBER = `#${741}`;
const CONTEXT_REVIEW_PR_NUMBER = `#${742}`;

const CONTEXT_WORK_PR_CARD: GithubEventCard = {
  type: "github_event",
  reason: "subscribed",
  event: "pull_request",
  action: "ready_for_review",
  kind: "reviewed",
  repository: "acme-shop/billing",
  sender: "nova-lead",
  title: `PR ${CONTEXT_WORK_PR_NUMBER}: Prevent duplicate checkout charges`,
  body: "Billing and auth regression tests passed.",
  url: "https://github.com/acme-shop/billing/pull/741",
  entity: {
    type: "pull_request",
    key: `acme-shop/billing${CONTEXT_WORK_PR_NUMBER}`,
    url: "https://github.com/acme-shop/billing/pull/741",
  },
};

const CONTEXT_REVIEW_PR_CARD: GithubEventCard = {
  type: "github_event",
  reason: "subscribed",
  event: "pull_request",
  action: "ready_for_review",
  kind: "reviewed",
  repository: "acme-team/context-tree",
  sender: "nova-lead",
  title: `PR ${CONTEXT_REVIEW_PR_NUMBER}: Record billing retry ownership`,
  body: "Context Tree update proposed from Prevent duplicate checkout charges.",
  url: "https://github.com/acme-team/context-tree/pull/742",
  entity: {
    type: "pull_request",
    key: `acme-team/context-tree${CONTEXT_REVIEW_PR_NUMBER}`,
    url: "https://github.com/acme-team/context-tree/pull/742",
  },
};

function ContextTreeChatScene({ time }: { time: number }) {
  if (time < 30) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-4">
        <TimelineMessage sender="Gandy" seed="human-gandy" at="09:02">
          Fix duplicate charges when checkout retries. Preserve the current auth boundary.
        </TimelineMessage>
        {time < 12 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body="Reading task-relevant Context Tree paths before changing code…"
            visible={progress(time, 0.9, 1.8)}
          />
        ) : null}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:06" visible={progress(time, 12, 12.8)}>
          I read <span className="mono text-label">system/billing</span>,{" "}
          <span className="mono text-label">security/auth</span>, and{" "}
          <span className="mono text-label">decisions/adr-019</span>. Billing executes charges; credentials and payment
          state stay server-side.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:08" visible={progress(time, 15, 15.8)}>
          Plan: enforce ADR-019 idempotency in Billing Service, leave Web’s authenticated flow unchanged, and cover both
          boundaries with regression tests.
        </TimelineMessage>
        {time < 22 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body="Implementing the smallest safe diff and running duplicate-charge and auth regression tests…"
            visible={progress(time, 18, 18.8)}
          />
        ) : (
          <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", columnGap: 8 }}>
            <GithubSystemAvatar size={20} />
            <div className="min-w-0" style={enterStyle(progress(time, 22, 22.8), 0.45)}>
              <p className="mono text-body mb-1 font-semibold text-primary">GitHub</p>
              <GithubEventCardMessage content={CONTEXT_WORK_PR_CARD} />
            </div>
          </div>
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:17" visible={progress(time, 25.2, 26)}>
          The work exposed a missing durable boundary: clients request retries; Billing Service owns idempotency and
          retry policy.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:18" visible={progress(time, 27.5, 28.3)}>
          Proposing <span className="mono text-label">system/billing/retry-ownership</span>, sourced from PR{" "}
          {CONTEXT_WORK_PR_NUMBER}. Implementation details stay in the code PR.
        </TimelineMessage>
      </div>
    );
  }
  if (time < 55) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-4">
        <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", columnGap: 8 }}>
          <GithubSystemAvatar size={20} />
          <div className="min-w-0" style={enterStyle(progress(time, 30, 30.8), 0.45)}>
            <p className="mono text-body mb-1 font-semibold text-primary">GitHub</p>
            <GithubEventCardMessage content={CONTEXT_REVIEW_PR_CARD} />
          </div>
        </div>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:19"
          visible={progress(time, 33, 33.8)}
        >
          Reading the current Tree and source PR {CONTEXT_WORK_PR_NUMBER} before reviewing the proposed knowledge.
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:21"
          visible={progress(time, 37, 37.8)}
        >
          Source evidence ✓ · Existing context ✓ · Auth boundary ✓
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:22"
          visible={progress(time, 41, 41.8)}
        >
          Durable value ✓ · One-off implementation details remain in PR {CONTEXT_WORK_PR_NUMBER}.
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:23"
          visible={progress(time, 44.5, 45.3)}
        >
          Approved. The source-backed ownership and rationale can update the Tree.
        </TimelineMessage>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-4">
      <TimelineMessage sender="Gandy" seed="human-gandy" at="10:04">
        Add retry handling to mobile checkout.
      </TimelineMessage>
      {time < 57 ? (
        <TimelineWorking
          sender="forge-dev"
          seed="forge-dev"
          body="Reading system/billing/retry-ownership before planning…"
          visible={progress(time, 55.2, 55.8)}
        />
      ) : (
        <TimelineMessage sender="forge-dev" seed="forge-dev" at="10:05" visible={progress(time, 57, 57.6)}>
          Context says clients only request retries; Billing Service owns idempotency and retry policy.
        </TimelineMessage>
      )}
      <TimelineMessage sender="forge-dev" seed="forge-dev" at="10:06" visible={progress(time, 58.3, 58.9)}>
        I’ll reuse that service contract and test the mobile auth handoff—no ownership debate to repeat.
      </TimelineMessage>
    </div>
  );
}

function TimelineMessage({
  sender,
  seed,
  at,
  visible = 1,
  children,
}: {
  sender: string;
  seed: string;
  at: string;
  visible?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
        ...enterStyle(visible, 0.45),
      }}
    >
      <Avatar name={sender} seed={seed} size={20} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline" style={{ gap: 8 }}>
          <span
            className="mono text-body font-semibold"
            style={{ color: sender === "Gandy" ? "var(--fg)" : "var(--primary)" }}
          >
            {sender}
          </span>
          <span className="mono text-caption text-fg-4">{at}</span>
        </div>
        <div className="text-body leading-relaxed" style={{ color: "var(--fg)", marginTop: 2 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function TimelineWorking({
  sender,
  seed,
  body,
  visible,
}: {
  sender: string;
  seed: string;
  body: string;
  visible: number;
}) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1) 0",
        ...enterStyle(visible, 0.45),
      }}
    >
      <Avatar name={sender} seed={seed} size={20} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline" style={{ gap: 6 }}>
          <span className="mono text-label font-semibold text-primary">{sender}</span>
          <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={8} />
          <span className="mono text-caption text-state-working">
            <span className="font-semibold">working</span> · now
          </span>
        </div>
        <div className="text-body mt-0.5">{body}</div>
      </div>
    </div>
  );
}

function ContextComposer({ recipient }: { recipient: string }) {
  return (
    <div className="shrink-0 border-t border-border bg-bg-raised p-3">
      <div className="flex min-h-12 items-center rounded-[var(--radius-input)] border border-border bg-background px-3 text-label text-fg-4">
        Message {recipient}…
        <Paperclip className="ml-auto size-4" />
        <span className="ml-2 flex size-7 items-center justify-center rounded-[var(--radius-input)] bg-primary text-primary-foreground">
          <Send className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function ContextRightSidebar({ time }: { time: number }) {
  const activeAgent = time < 30 ? "nova-lead" : time < 55 ? "context-reviewer" : "forge-dev";
  const workingUntil = time < 30 ? 28.5 : time < 55 ? 45.5 : 59;
  return (
    <aside className="w-75 shrink-0 overflow-hidden border-l border-border bg-bg-raised">
      <section className="border-b border-border-faint">
        <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
          Participants <span className="mono">· 2</span>
        </div>
        <div className="flex flex-col px-2 pb-1" style={{ gap: 2 }}>
          <ContextParticipantStatusRow name={activeAgent} status={time < workingUntil ? "Working" : "Idle"} />
          <ContextParticipantStatusRow name="Gandy" human />
        </div>
        <div className="px-2 pb-2 pt-1">
          <div className="flex items-center px-2 py-1.5 text-fg-3" style={{ gap: "var(--sp-2_5)" }}>
            <UserPlus size={16} />
            <span className="text-body">Add</span>
          </div>
        </div>
      </section>
    </aside>
  );
}

function ContextParticipantStatusRow({
  name,
  status,
  human = false,
}: {
  name: string;
  status?: "Working" | "Idle";
  human?: boolean;
}) {
  const working = status === "Working";
  return (
    <div
      className="flex items-center"
      style={{ gap: "var(--sp-2_5)", padding: "var(--sp-1_25) var(--sp-2)", borderRadius: "var(--radius-input)" }}
    >
      <span className="relative block size-7 shrink-0">
        <Avatar name={name} seed={name} size={28} />
        {!human ? (
          <span className="absolute -bottom-0.5 -right-0.5">
            <StatusGlyph
              colorVar={working ? "var(--state-working)" : "var(--state-idle)"}
              shape="dot"
              pulse={working ? "working" : null}
              size={9}
              separator
            />
          </span>
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{name}</div>
        {!human ? (
          <div className="text-caption" style={{ color: working ? "var(--state-working)" : "var(--state-idle)" }}>
            {status}
          </div>
        ) : null}
      </div>
    </div>
  );
}
