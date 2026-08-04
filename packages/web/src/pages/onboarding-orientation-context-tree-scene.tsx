import type { GithubEventCard, MeChatRow } from "@first-tree/shared";
import { ChevronDown, Filter, ListTree, PanelRight, Paperclip, Plus, Send, UserPlus, Users } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Avatar } from "../components/avatar.js";
import { ActivityDots } from "../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../components/chat/chat-row-avatar.js";
import { GithubEventCardMessage, GithubSystemAvatar } from "../components/chat/github-event-card.js";
import { Button } from "../components/ui/button.js";
import { StatusGlyph } from "../components/ui/status-glyph.js";

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

type LoopPhase = "read" | "work" | "propose" | "review" | "update" | "reuse";

const LOOP_PHASES: readonly { id: LoopPhase; label: string }[] = [
  { id: "read", label: "Read" },
  { id: "work", label: "Work" },
  { id: "propose", label: "Draft" },
  { id: "review", label: "Review" },
  { id: "update", label: "Update" },
  { id: "reuse", label: "Reuse" },
];

function loopPhase(time: number): LoopPhase {
  if (time < 10) return "read";
  if (time < 24) return "work";
  if (time < 29) return "propose";
  if (time < 43) return "review";
  if (time < 50) return "update";
  return "reuse";
}

export function ContextTreeOrientationScene({ time }: { time: number }) {
  const phase = loopPhase(time);
  const recipient = time < 29 ? "nova-lead" : time < 50 ? "context-reviewer" : "forge-dev";

  return (
    <div className="relative flex h-[calc(100vh-3rem)] min-h-0 overflow-hidden bg-background">
      <ContextConversationRail time={time} />
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        <ContextChatHeader time={time} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ContextTreeChatScene time={time} />
        </div>
        <ContextComposer recipient={recipient} />
      </main>
      <ContextRightSidebar time={time} />
      <ContextLoopOverlay time={time} phase={phase} />
    </div>
  );
}

function ContextChatHeader({ time }: { time: number }) {
  const title =
    time < 29
      ? "Prevent duplicate checkout charges"
      : time < 50
        ? "Review Context update"
        : "Add mobile checkout retries";
  return (
    <header className="flex min-h-12 shrink-0 items-center bg-bg-raised px-5 py-1.5">
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
  const workSelected = time < 29;
  const reviewSelected = time >= 29 && time < 50;
  return (
    <aside
      data-context-conversation-rail
      className="flex w-70 shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised"
    >
      <ContextConversationRailHeader itemCount={time < 29 ? 1 : time < 50 ? 2 : 3} />
      <ContextRailItem
        title="Prevent duplicate checkout charges"
        participants={WORK_PARTICIPANTS}
        selected={workSelected}
        timeLabel={workSelected ? undefined : "8m"}
        working={workSelected && time < 27.5}
      />
      {time >= 29 ? (
        <ContextRailItem
          title="Review Context update"
          participants={REVIEW_PARTICIPANTS}
          selected={reviewSelected}
          working={reviewSelected && time < 46}
          timeLabel={reviewSelected ? undefined : "3m"}
        />
      ) : null}
      {time >= 50 ? (
        <ContextRailItem
          title="Add mobile checkout retries"
          participants={NEXT_TASK_PARTICIPANTS}
          selected={!workSelected && !reviewSelected}
          working={time < 58.5}
        />
      ) : null}
    </aside>
  );
}

function ContextConversationRailHeader({ itemCount }: { itemCount: number }) {
  return (
    <div className="flex shrink-0 flex-col border-b border-border-faint">
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
  body: "Durable context proposed from the verified code change.",
  url: "https://github.com/acme-team/context-tree/pull/742",
  entity: {
    type: "pull_request",
    key: `acme-team/context-tree${CONTEXT_REVIEW_PR_NUMBER}`,
    url: "https://github.com/acme-team/context-tree/pull/742",
  },
};

function ContextTreeChatScene({ time }: { time: number }) {
  if (time < 29) {
    return (
      <div className="mx-auto w-full px-5 py-3.5">
        <TimelineMessage sender="Gandy" seed="human-gandy" at="09:02">
          Fix duplicate charges when checkout retries. Preserve the current auth boundary.
        </TimelineMessage>
        {time < 10 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body="Reading the task-relevant Context Tree paths before planning…"
            visible={progress(time, 1, 1.8)}
          />
        ) : (
          <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:04" visible={progress(time, 10, 10.8)}>
            Loaded the settled billing, auth, and ADR-019 constraints. Billing owns charge execution; credentials and
            payment state stay server-side.
          </TimelineMessage>
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:06" visible={progress(time, 13, 13.8)}>
          I’ll enforce ADR-019 idempotency in Billing Service, preserve Web’s authenticated handoff, and test both
          boundaries.
        </TimelineMessage>
        {time < 20.5 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body="Implementing the smallest safe diff and running billing and auth regression tests…"
            visible={progress(time, 16, 16.8)}
          />
        ) : (
          <GithubTimelineCard content={CONTEXT_WORK_PR_CARD} visible={progress(time, 20.5, 21.3)} />
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:17" visible={progress(time, 24, 24.8)}>
          This work settled a reusable boundary: clients request retries; Billing Service owns idempotency and retry
          policy.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:18" visible={progress(time, 26.5, 27.3)}>
          Proposing <span className="mono text-label">system/billing/retry-ownership</span> from PR{" "}
          {CONTEXT_WORK_PR_NUMBER}. One-off implementation details stay in the code PR.
        </TimelineMessage>
      </div>
    );
  }

  if (time < 50) {
    return (
      <div className="mx-auto w-full px-5 py-3.5">
        <GithubTimelineCard content={CONTEXT_REVIEW_PR_CARD} visible={progress(time, 29, 29.8)} />
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:19"
          visible={progress(time, 31, 31.8)}
        >
          Reading the existing Tree and source PR {CONTEXT_WORK_PR_NUMBER} before reviewing the proposed knowledge.
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:21"
          visible={progress(time, 35, 35.8)}
        >
          Source evidence ✓ · Existing context ✓ · Authorization boundary ✓
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:22"
          visible={progress(time, 39, 39.8)}
        >
          Durable value ✓ · No temporary implementation detail copied into shared context.
        </TimelineMessage>
        <TimelineMessage
          sender="context-reviewer"
          seed="context-reviewer"
          at="09:23"
          visible={progress(time, 42, 42.8)}
        >
          Approved. The source-backed ownership and rationale can update the Tree.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="09:24" visible={progress(time, 46, 46.8)}>
          Updated <span className="mono text-label">system/billing/retry-ownership</span> in PR{" "}
          {CONTEXT_REVIEW_PR_NUMBER}.
        </TimelineMessage>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full px-5 py-3.5">
      <TimelineMessage sender="Gandy" seed="human-gandy" at="10:04">
        Add retry handling to mobile checkout.
      </TimelineMessage>
      {time < 54.5 ? (
        <TimelineWorking
          sender="forge-dev"
          seed="forge-dev"
          body="Reading system/billing/retry-ownership before planning…"
          visible={progress(time, 50.5, 51.3)}
        />
      ) : (
        <TimelineMessage sender="forge-dev" seed="forge-dev" at="10:05" visible={progress(time, 54.5, 55.3)}>
          The Tree already says clients request retries while Billing Service owns idempotency and retry policy.
        </TimelineMessage>
      )}
      <TimelineMessage sender="forge-dev" seed="forge-dev" at="10:06" visible={progress(time, 57, 57.8)}>
        I’ll reuse that service contract and test the mobile auth handoff—no ownership debate to repeat.
      </TimelineMessage>
    </div>
  );
}

function GithubTimelineCard({ content, visible }: { content: GithubEventCard; visible: number }) {
  return (
    <div className="grid py-1" style={{ gridTemplateColumns: "var(--sp-5) 1fr", columnGap: 8 }}>
      <GithubSystemAvatar size={20} />
      <div className="min-w-0" style={enterStyle(visible, 0.45)}>
        <p className="mono text-body mb-1 font-semibold text-primary">GitHub</p>
        <GithubEventCardMessage content={content} />
      </div>
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
  const activeAgent = time < 29 ? "nova-lead" : time < 50 ? "context-reviewer" : "forge-dev";
  const workingUntil = time < 29 ? 27.5 : time < 50 ? 46 : 58.5;
  return (
    <aside data-context-details-rail className="w-75 shrink-0 overflow-hidden border-l border-border bg-bg-raised">
      <section className="border-b border-border-faint">
        <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
          Participants <span className="mono">· 2</span>
        </div>
        <div className="flex flex-col px-2 pb-2" style={{ gap: 2 }}>
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

function ContextLoopOverlay({ time, phase }: { time: number; phase: LoopPhase }) {
  const activeIndex = LOOP_PHASES.findIndex((item) => item.id === phase);
  const phaseCopy = {
    read: "Task-relevant paths are being read",
    work: "Settled context is guiding the work",
    propose: "A durable boundary is being proposed",
    review: "Evidence and boundaries are being checked",
    update: "Approved knowledge is entering the Tree",
    reuse: "The next Agent starts from the update",
  }[phase];

  return (
    <figure
      data-context-loop-phase={phase}
      data-context-tree-visual="explanatory-overlay"
      className="pointer-events-none absolute right-2 top-20 z-20 w-75"
      aria-label="Video explanation of the Context Tree loop"
    >
      <div className="mb-1.5 flex items-center justify-end" style={{ gap: "var(--sp-1_5)" }}>
        <span className="h-px w-8 bg-primary" aria-hidden />
        <figcaption className="mono text-eyebrow rounded-full border border-primary bg-background px-2 py-1 font-bold uppercase text-primary shadow-sm">
          Context Tree loop · explainer
        </figcaption>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-dashed border-primary bg-background/95 p-2.5 shadow-[var(--shadow-md)] backdrop-blur-sm">
        <div className="grid grid-cols-6" style={{ gap: 3 }}>
          {LOOP_PHASES.map((item, index) => {
            const reached = index <= activeIndex;
            const active = item.id === phase;
            return (
              <div key={item.id} className="min-w-0 text-center">
                <div
                  className="h-1 w-full rounded-full"
                  style={{ background: reached ? "var(--brand)" : "var(--border)" }}
                />
                <span
                  className={`mono text-eyebrow mt-1 block truncate uppercase ${active ? "font-bold text-foreground" : "font-medium text-fg-4"}`}
                >
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
        <ContextTreeMap time={time} phase={phase} />
        <div className="mt-1.5 flex min-h-8 items-center border-t border-border-faint px-1 pt-1.5">
          <StatusGlyph
            colorVar={phase === "review" ? "var(--warning)" : "var(--state-working)"}
            shape="dot"
            pulse={phase === "read" || phase === "review" || phase === "update" || phase === "reuse" ? "working" : null}
            size={8}
          />
          <span className="text-caption ml-2 leading-snug text-fg-2">{phaseCopy}</span>
        </div>
      </div>
    </figure>
  );
}

type MapNodeId = "root" | "system" | "billing" | "security" | "auth" | "decisions" | "adr" | "ownership";

const MAP_NODES: readonly {
  id: MapNodeId;
  x: number;
  y: number;
  width: number;
  label: string;
  path?: string;
}[] = [
  { id: "root", x: 95, y: 8, width: 86, label: "Context Tree" },
  { id: "system", x: 8, y: 56, width: 76, label: "System" },
  { id: "security", x: 100, y: 56, width: 76, label: "Security" },
  { id: "decisions", x: 192, y: 56, width: 76, label: "Decisions" },
  { id: "billing", x: 8, y: 108, width: 76, label: "Billing", path: "system/billing" },
  { id: "auth", x: 100, y: 108, width: 76, label: "Auth", path: "security/auth" },
  { id: "adr", x: 192, y: 108, width: 76, label: "ADR-019", path: "decisions/adr-019" },
  { id: "ownership", x: 8, y: 166, width: 116, label: "Retry ownership", path: "system/billing/retry-ownership" },
];

const MAP_NODE_LOOKUP = new Map(MAP_NODES.map((node) => [node.id, node]));

function ContextTreeMap({ time, phase }: { time: number; phase: LoopPhase }) {
  const readTargets: readonly MapNodeId[] = ["billing", "auth", "adr"];
  const readIndex = Math.min(readTargets.length - 1, Math.floor(progress(time, 1.8, 9.2) * readTargets.length));
  const targetId: MapNodeId =
    phase === "read"
      ? (readTargets[readIndex] ?? "billing")
      : phase === "review" || phase === "propose" || phase === "update" || phase === "reuse"
        ? "ownership"
        : "billing";
  const target = MAP_NODE_LOOKUP.get(targetId);
  if (target === undefined) return null;
  const showOwnership = phase === "propose" || phase === "review" || phase === "update" || phase === "reuse";
  const ownershipProgress = phase === "update" ? ease(progress(time, 43, 47)) : phase === "reuse" ? 1 : 0;
  const operation = phase === "update" ? "WRITE" : phase === "work" ? "APPLY" : phase === "propose" ? "DRAFT" : "READ";
  const cursorX = target.x + target.width - 8;
  const cursorY = targetId === "ownership" ? target.y + 2 : target.y + 25;

  return (
    <svg
      className="mt-1.5 block w-full bg-transparent"
      style={{ height: 200 }}
      viewBox="0 0 276 216"
      role="img"
      aria-label="Explanatory Context Tree map showing the current read or update"
    >
      <title>Context Tree map</title>
      <g fill="none" stroke="var(--border)" strokeWidth="1.2">
        <path d="M138 38 V47 H46 V56" />
        <path d="M138 38 V56" />
        <path d="M138 47 H230 V56" />
        <path d="M46 86 V108" />
        <path d="M138 86 V108" />
        <path d="M230 86 V108" />
        {showOwnership ? (
          <path
            d="M46 138 V166"
            stroke={phase === "update" || phase === "reuse" ? "var(--brand)" : "var(--fg-4)"}
            strokeDasharray={phase === "update" || phase === "reuse" ? undefined : "4 3"}
          />
        ) : null}
      </g>
      {MAP_NODES.map((node) => {
        if (node.id === "ownership" && !showOwnership) return null;
        const selected =
          node.id === targetId ||
          (phase === "work" && (node.id === "billing" || node.id === "auth" || node.id === "adr"));
        const approvedOwnership = node.id === "ownership" && (phase === "reuse" || ownershipProgress > 0.45);
        return (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={30}
              rx={4}
              fill={selected ? "var(--brand-bg)" : "var(--bg-raised)"}
              stroke={selected ? "var(--brand)" : "var(--border)"}
              strokeWidth={selected ? 1.8 : 1}
              strokeDasharray={node.id === "ownership" && !approvedOwnership ? "4 3" : undefined}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + (node.path ? 11 : 18)}
              textAnchor="middle"
              fill="var(--fg)"
              fontSize={node.path ? 9.5 : 10.5}
              fontWeight={selected ? 700 : 600}
            >
              {node.label}
            </text>
            {node.path ? (
              <text
                x={node.x + node.width / 2}
                y={node.y + 23}
                textAnchor="middle"
                fill="var(--fg-4)"
                fontSize={node.id === "ownership" ? 6.5 : 7.5}
              >
                {node.id === "ownership" ? "system/billing/retry-ownership" : node.path}
              </text>
            ) : null}
            {approvedOwnership ? (
              <g transform={`translate(${node.x + node.width - 10} ${node.y + 4})`}>
                <circle cx="0" cy="0" r="7" fill="var(--success)" />
                <path d="M-3 0 L-1 2.5 L3.5 -2.5" fill="none" stroke="white" strokeWidth="1.5" />
              </g>
            ) : null}
          </g>
        );
      })}
      <g transform={`translate(${cursorX} ${cursorY})`}>
        <line x1="0" y1="0" x2="13" y2="13" stroke="var(--primary)" strokeWidth="1.2" strokeDasharray="2 2" />
        <path d="M12 11 L25 15 L18 20 Z" fill="var(--primary)" />
        <rect x="22" y="22" width="42" height="16" rx="3" fill="var(--fg)" />
        <text x="43" y="33" textAnchor="middle" fill="var(--bg)" fontSize="8" fontWeight="700">
          {operation}
        </text>
      </g>
      {phase === "reuse" ? (
        <g transform="translate(151 177)">
          <circle cx="8" cy="8" r="8" fill="var(--success)" />
          <path d="M4 8 L7 11 L12 5" fill="none" stroke="white" strokeWidth="1.7" />
          <text x="21" y="11" fill="var(--fg-2)" fontSize="9.5" fontWeight="600">
            Shared starting point
          </text>
        </g>
      ) : null}
    </svg>
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
