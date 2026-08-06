import type { AskRequest, ContextDecision, GithubEventCard } from "@first-tree/shared";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AskTakeover } from "../components/chat/ask-takeover.js";
import { ContextDecisionReceipt } from "../components/chat/context-decision-receipt.js";
import { GithubEventCardMessage } from "../components/chat/github-event-card.js";
import { FirstTreeLogo } from "../components/first-tree-logo.js";

/**
 * DEV-only visual review for `AskTakeover` plus narrow timeline overflow
 * fixtures. No backend / no auth — same gating as the other `/preview/*`
 * routes (DEV-only in `app.tsx`). Each ask mode renders the production card
 * inside a relative box (the card is an absolute scrim that fills it).
 */

const BODY = [
  "## Ship the rollout to 20% now, or hold for another 24h?",
  "",
  "Rollout has sat at `5%` for 24h with the error rate flat and no new Sentry groups. Holding buys weekend bake",
  "time but delays the dependent `billing` migration gated on this.",
  "",
  "### What I'd weigh",
  "- Error budget is healthy; nothing in the dashboards argues against proceeding.",
  "- The billing migration team is waiting on 20% before they cut over.",
  "",
  "### Verification command",
  "```sh",
  "first-tree-staging tree verify --tree-path /Users/reviewer/first-tree-context/very-long-mobile-verification-worktree",
  "```",
].join("\n");

const SINGLE_PAYLOAD: AskRequest = {
  multiSelect: false,
  options: [
    { label: "Ship to 20%", description: "Proceed now — error budget is healthy and unblocks billing." },
    {
      label: "Hold 24h",
      description: "Bake over the weekend; billing slips a day.",
      preview: "# re-evaluate Monday 09:00",
    },
  ],
};
const MULTI_PAYLOAD: AskRequest = {
  multiSelect: true,
  options: [
    { label: "Web", description: "ship the web surface" },
    { label: "CLI", description: "ship the CLI surface" },
    {
      label: "API",
      description: "ship the public API",
      preview:
        "https://example.invalid/qa/mobile-ask-card-very-long-preview/endpoint?token=abcdefghijklmnopqrstuvwxyz0123456789&scope=read:write:admin&note=this-is-a-deliberately-very-long-single-token-preview-to-exercise-overflow-wrap-and-scroll-clipping",
    },
  ],
};

const COMMIT_SHA = "abcdef0123456789".repeat(3).slice(0, 40);
const COMMIT_CARD: GithubEventCard = {
  type: "github_event",
  reason: "subscribed",
  event: "commit_comment",
  action: "created",
  kind: "commit_commented",
  repository: "agent-team-foundation/first-tree",
  sender: "mobile-reviewer-with-a-long-handle",
  title: "Commit: Keep the mobile timeline inside its reading column",
  body: `Verification target ${"unbroken".repeat(30)}`,
  url: `https://github.com/agent-team-foundation/first-tree/commit/${COMMIT_SHA}`,
  entity: {
    type: "commit",
    key: `agent-team-foundation/first-tree@${COMMIT_SHA}`,
    url: `https://github.com/agent-team-foundation/first-tree/commit/${COMMIT_SHA}`,
  },
};

/**
 * Agent-reported Context Tree receipts, one per observable effect. Same shape
 * the `first-tree-read` skill attaches to a real final send, so this preview
 * exercises the production component rather than a look-alike.
 */
const RECEIPTS: ContextDecision[] = [
  {
    version: 1,
    effect: "conflicted",
    summary: "The error budget supports expansion, but the weekend freeze blocks rollout changes after 18:00.",
    evidence: [
      {
        repoUrl: "https://github.com/agent-team-foundation/first-tree-context",
        commit: COMMIT_SHA,
        nodePath: "product/release/rollout-policy.md",
        heading: "Weekend change freeze",
      },
      {
        repoUrl: "https://github.com/agent-team-foundation/first-tree-context",
        commit: COMMIT_SHA,
        nodePath: "product/reliability/error-budget.md",
        heading: "Expansion threshold",
      },
    ],
  },
  {
    version: 1,
    effect: "redirected",
    summary: "The approved migration sequence requires Web adoption before CLI expansion, so the order was reversed.",
    evidence: [
      {
        repoUrl: "https://github.com/agent-team-foundation/first-tree-context",
        commit: COMMIT_SHA,
        nodePath: "product/billing/migration-sequence.md",
        heading: "Web adoption first",
      },
    ],
  },
  {
    version: 1,
    effect: "constrained",
    summary: "Team rollout policy caps Web at 20%; CLI remains at 5% until the migration guard is cleared.",
    evidence: [
      {
        repoUrl: "https://github.com/agent-team-foundation/first-tree-context",
        commit: COMMIT_SHA,
        nodePath: "product/release/rollout-policy.md",
        heading: "Expansion gates",
      },
      {
        repoUrl: "https://gitlab.example.com/team/context-tree",
        commit: COMMIT_SHA,
        nodePath: "product/release/very/deeply/nested/surface-rollout-order-and-gates.md",
      },
    ],
  },
  {
    version: 1,
    effect: "confirmed",
    summary: "Current expansion gates and the latest error-budget decision both support moving Web from 5% to 20%.",
    evidence: [
      {
        repoUrl: "https://github.com/agent-team-foundation/first-tree-context",
        commit: COMMIT_SHA,
        nodePath: "product/reliability/error-budget.md",
        heading: "Expansion threshold",
      },
    ],
  },
];

const MODES: { label: string; payload: AskRequest }[] = [
  { label: "options · single", payload: SINGLE_PAYLOAD },
  { label: "options · multi", payload: MULTI_PAYLOAD },
  { label: "free text", payload: { multiSelect: false } },
];

/**
 * PROTOTYPE — three density directions for the shipped receipt, switchable on
 * the existing `/preview/request-dock?prototype=receipt-density&variant=A`
 * route. This answers one question only: how much vertical chrome can be
 * removed without hiding the reported outcome, summary, or inspectable sources?
 */
type DensityVariant = "A" | "B" | "C";

const DENSITY_VARIANTS: { key: DensityVariant; name: string }[] = [
  { key: "A", name: "Compact disclosure" },
  { key: "B", name: "Inline footnote" },
  { key: "C", name: "Single-row signal" },
];

function readDensityVariant(value: string | null): DensityVariant {
  return value === "B" || value === "C" ? value : "A";
}

function DensityPrototypePage({
  variant,
  onVariantChange,
}: {
  variant: DensityVariant;
  onVariantChange: (variant: DensityVariant) => void;
}) {
  const receipt = RECEIPTS[2];
  if (!receipt) return null;
  const selected = DENSITY_VARIANTS.find((item) => item.key === variant) ?? DENSITY_VARIANTS[0]!;

  return (
    <main className="min-h-screen" style={{ padding: "var(--sp-6)", background: "var(--bg-sunken)" }}>
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between" style={{ gap: "var(--sp-3)" }}>
          <div>
            <div className="text-eyebrow uppercase" style={{ color: "var(--brand-dim)" }}>
              Throwaway prototype · receipt density
            </div>
            <h1 className="text-title" style={{ marginTop: "var(--sp-1)" }}>
              Keep the value; remove the vertical chrome
            </h1>
            <p className="text-body" style={{ marginTop: "var(--sp-1)", color: "var(--fg-2)" }}>
              Current production card compared with {selected.key} · {selected.name}.
            </p>
          </div>
          <div className="text-caption" style={{ color: "var(--fg-3)" }}>
            Desktop and mobile use the same content order
          </div>
        </div>

        <div className="grid lg:grid-cols-2" style={{ marginTop: "var(--sp-5)", gap: "var(--sp-4)" }}>
          <PrototypeMessage label="Current production">
            <ContextDecisionReceipt receipt={receipt} gitlabInstanceOrigin="https://gitlab.example.com" />
          </PrototypeMessage>
          <PrototypeMessage label={`${selected.key} · ${selected.name}`} recommended={variant === "A"}>
            <DensityReceipt variant={variant} receipt={receipt} />
          </PrototypeMessage>
        </div>

        <div
          className="surface-raised text-body"
          style={{ marginTop: "var(--sp-4)", padding: "var(--sp-3)" }}
        >
          {variant === "A" ? (
            <>
              <span className="font-semibold">Recommended.</span> The whole receipt becomes the disclosure target, so
              the separate source row disappears. Context Tree and the effect share one header; the summary remains
              fully visible, and the source count moves into the expanded details.
            </>
          ) : variant === "B" ? (
            <>
              <span className="font-semibold">Smallest visual footprint.</span> It reads as a footnote to the answer,
              but the Context Tree value is easier to miss during normal scanning.
            </>
          ) : (
            <>
              <span className="font-semibold">Highest scan density.</span> It works for short summaries, but truncation
              hides the concrete reason on narrow screens, so it is a poor default.
            </>
          )}
        </div>
      </div>
      <DensityVariantSwitcher current={variant} onChange={onVariantChange} />
    </main>
  );
}

function PrototypeMessage({
  label,
  recommended = false,
  children,
}: {
  label: string;
  recommended?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="surface-raised overflow-hidden">
      <div
        className="text-caption font-semibold flex items-center justify-between"
        style={{ padding: "var(--sp-2) var(--sp-3)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <span>{label}</span>
        {recommended ? <span style={{ color: "var(--brand-dim)" }}>Recommended</span> : null}
      </div>
      <div style={{ padding: "var(--sp-4)" }}>
        <div className="flex items-start" style={{ gap: "var(--sp-2_5)" }}>
          <div
            className="text-label font-semibold grid size-8 shrink-0 place-items-center rounded-[var(--radius-full)]"
            style={{ background: "var(--state-working-soft)", color: "var(--brand-dim)" }}
          >
            D
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-caption font-semibold">deploy-agent</div>
            <div className="text-body" style={{ marginTop: "var(--sp-1)" }}>
              Recommendation: expand Web to 20%, keep CLI at 5%.
            </div>
            <p className="text-body" style={{ marginTop: "var(--sp-1)", color: "var(--fg-2)" }}>
              Web is ready to expand; CLI still needs its migration guard cleared.
            </p>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

function DensityReceipt({ variant, receipt }: { variant: DensityVariant; receipt: ContextDecision }) {
  const [open, setOpen] = useState(false);
  const count = `${receipt.evidence.length} decisions`;

  if (variant === "B") {
    return (
      <aside
        style={{ marginTop: "var(--sp-3)", paddingTop: "var(--sp-2)", borderTop: "var(--hairline) solid var(--border)" }}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="text-left w-full min-h-11"
        >
          <div className="text-body flex items-start" style={{ gap: "var(--sp-2)" }}>
            <FirstTreeLogo width={12} height={14} style={{ marginTop: "var(--sp-0_5)", color: "var(--brand)" }} />
            <p className="min-w-0 flex-1 leading-relaxed">
              <span className="font-semibold">Options narrowed</span>
              <span style={{ color: "var(--fg-2)" }}> — {receipt.summary}</span>
            </p>
            <span className="text-caption shrink-0" style={{ color: "var(--fg-3)" }}>
              {count}
            </span>
            {open ? <ChevronUp aria-hidden className="size-3.5 shrink-0" /> : <ChevronDown aria-hidden className="size-3.5 shrink-0" />}
          </div>
          <div className="text-caption" style={{ margin: "var(--sp-1) 0 0 var(--sp-5)", color: "var(--brand-dim)" }}>
            Context Tree
          </div>
        </button>
        {open ? <CompactEvidence receipt={receipt} /> : null}
      </aside>
    );
  }

  if (variant === "C") {
    return (
      <aside style={{ marginTop: "var(--sp-3)", background: "var(--brand-bg)", borderRadius: "var(--radius-panel)" }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="text-body flex w-full min-h-11 items-center text-left"
          style={{ padding: "var(--sp-2) var(--sp-2_5)", gap: "var(--sp-2)" }}
        >
          <FirstTreeLogo width={12} height={14} style={{ flexShrink: 0, color: "var(--brand)" }} />
          <span className="font-semibold shrink-0">Options narrowed</span>
          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--fg-2)" }}>
            {receipt.summary}
          </span>
          <span className="text-caption shrink-0" style={{ color: "var(--fg-3)" }}>
            {count}
          </span>
          {open ? <ChevronUp aria-hidden className="size-3.5 shrink-0" /> : <ChevronDown aria-hidden className="size-3.5 shrink-0" />}
        </button>
        {open ? <CompactEvidence receipt={receipt} inset /> : null}
      </aside>
    );
  }

  return (
    <aside style={{ marginTop: "var(--sp-3)", background: "var(--brand-bg)", borderRadius: "var(--radius-panel)" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left"
        style={{ padding: "var(--sp-2_5)" }}
      >
        <div className="flex items-start" style={{ gap: "var(--sp-2)" }}>
          <FirstTreeLogo width={12} height={14} style={{ marginTop: "var(--sp-0_5)", flexShrink: 0, color: "var(--brand)" }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
              <span className="text-caption font-semibold" style={{ color: "var(--brand-dim)" }}>
                Context Tree
              </span>
              <span className="text-body font-semibold min-w-0 flex-1">Options narrowed</span>
              {open ? <ChevronUp aria-hidden className="size-3.5 shrink-0" /> : <ChevronDown aria-hidden className="size-3.5 shrink-0" />}
            </div>
            <p className="text-body leading-relaxed" style={{ marginTop: "var(--sp-1)", color: "var(--fg-2)" }}>
              {receipt.summary}
            </p>
          </div>
        </div>
      </button>
      {open ? <CompactEvidence receipt={receipt} inset /> : null}
    </aside>
  );
}

function CompactEvidence({ receipt, inset = false }: { receipt: ContextDecision; inset?: boolean }) {
  const version = receipt.evidence[0]?.commit.slice(0, 7);
  return (
    <div
      style={{
        margin: inset ? "0 var(--sp-2_5)" : "var(--sp-2) 0 0 var(--sp-5)",
        padding: "var(--sp-2) 0 var(--sp-2_5)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <ul className="flex flex-col" style={{ listStyle: "none", margin: 0, padding: 0, gap: "var(--sp-1)" }}>
        {receipt.evidence.map((evidence) => (
          <li key={evidence.nodePath} className="min-h-11 flex items-center" title={evidence.nodePath}>
            <div className="text-label font-medium flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1)" }}>
              <span className="truncate">{humanizeNodeName(evidence.nodePath)}</span>
              {evidence.heading ? (
                <>
                  <span aria-hidden style={{ color: "var(--fg-3)" }}>
                    ·
                  </span>
                  <span className="truncate" style={{ color: "var(--fg-2)" }}>
                    {evidence.heading}
                  </span>
                </>
              ) : null}
            </div>
            <ExternalLink aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--fg-3)" }} />
          </li>
        ))}
      </ul>
      {version ? (
        <div className="text-caption" style={{ paddingTop: "var(--sp-1)", color: "var(--fg-3)" }}>
          {receipt.evidence.length} decisions · Context Tree version {version}
        </div>
      ) : null}
      <p
        className="text-caption leading-relaxed"
        style={{ marginTop: "var(--sp-2)", paddingTop: "var(--sp-2)", borderTop: "var(--hairline) solid var(--border-faint)", color: "var(--fg-3)" }}
      >
        Influence is agent-reported, not independently verified.
      </p>
    </div>
  );
}

function humanizeNodeName(nodePath: string): string {
  const fileName = nodePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? nodePath;
  return fileName
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function DensityVariantSwitcher({
  current,
  onChange,
}: {
  current: DensityVariant;
  onChange: (variant: DensityVariant) => void;
}) {
  const currentIndex = DENSITY_VARIANTS.findIndex((item) => item.key === current);
  const cycle = (offset: number) => {
    const next = DENSITY_VARIANTS[(currentIndex + offset + DENSITY_VARIANTS.length) % DENSITY_VARIANTS.length];
    if (next) onChange(next.key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const selected = DENSITY_VARIANTS[currentIndex] ?? DENSITY_VARIANTS[0]!;
  return (
    <div
      className="surface-overlay fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center"
      style={{ padding: "var(--sp-1)", gap: "var(--sp-1)" }}
    >
      <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)} className="grid size-9 place-items-center">
        <ChevronLeft aria-hidden className="size-4" />
      </button>
      <div className="text-label font-semibold" style={{ minWidth: "var(--sp-35)", textAlign: "center" }}>
        {selected.key} · {selected.name}
      </div>
      <button type="button" aria-label="Next variant" onClick={() => cycle(1)} className="grid size-9 place-items-center">
        <ChevronRight aria-hidden className="size-4" />
      </button>
    </div>
  );
}

function ModeBlock({
  label,
  payload,
  height = 560,
  mobile = false,
  contextDecision = null,
}: {
  label: string;
  payload: AskRequest;
  height?: number;
  mobile?: boolean;
  contextDecision?: ContextDecision | null;
}) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <section style={{ marginBottom: "var(--sp-6)" }}>
      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        {label}
      </h2>
      <div
        style={{
          position: "relative",
          marginTop: "var(--sp-2)",
          height,
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <AskTakeover
          body={BODY}
          contextDecision={contextDecision}
          payload={payload}
          askerName="deploy-agent"
          mobile={mobile}
          onReply={(answer) =>
            setStatus(
              `Submit → ${answer.content.replace(/\n/g, " · ")}` +
                (answer.mentions.length > 0 ? ` · @${answer.mentions.length}` : "") +
                (answer.images.length > 0 ? ` · ${answer.images.length}🖼` : ""),
            )
          }
          onSkip={() => setStatus("Skipped → resolves the request with a skipped answer")}
        />
      </div>
      {status ? (
        <div className="mono text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
          {status}
        </div>
      ) : null}
    </section>
  );
}

export function RequestDockPreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  if (searchParams.get("prototype") === "receipt-density") {
    const variant = readDensityVariant(searchParams.get("variant"));
    return (
      <DensityPrototypePage
        variant={variant}
        onVariantChange={(nextVariant) => {
          const next = new URLSearchParams(searchParams);
          next.set("prototype", "receipt-density");
          next.set("variant", nextVariant);
          setSearchParams(next, { replace: true });
        }}
      />
    );
  }

  return (
    <div style={{ padding: "var(--sp-6)", background: "var(--bg-sunken)", minHeight: "100vh" }}>
      <h1 className="text-subtitle font-semibold" style={{ marginBottom: "var(--sp-1)" }}>
        AskTakeover preview
      </h1>
      <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-4)" }}>
        The ask body and the answer surface (options + Other) share one scroll region; only the Skip / Submit footer
        stays pinned, so Submit is reachable at any height. Both resolve the question: Submit sends the composed answer,
        Skip sends a skipped answer (there is no keep-it-open path).
      </p>
      {MODES.map((m, index) => (
        <ModeBlock
          key={m.label}
          label={m.label}
          payload={m.payload}
          contextDecision={index === 0 ? RECEIPTS[0] : null}
        />
      ))}

      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        Context Tree decision receipt — the four observable effects
      </h2>
      <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-1) 0 var(--sp-4)" }}>
        Rendered where it ships: under the agent result it explains. Collapsed shows what team context did and what
        changed; expanding reveals the exact cited nodes, repository and commit, plus the agent-attribution note.
      </p>
      {RECEIPTS.map((receipt) => (
        <div
          key={receipt.effect}
          style={{
            marginBottom: "var(--sp-4)",
            padding: "var(--sp-3)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-panel)",
            background: "var(--bg-raised)",
          }}
        >
          <div className="text-body">Recommendation: expand Web to 20%, keep CLI at 5%.</div>
          <ContextDecisionReceipt receipt={receipt} gitlabInstanceOrigin="https://gitlab.example.com" />
        </div>
      ))}

      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        cramped height — footer must stay reachable
      </h2>
      <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-1) 0 var(--sp-4)" }}>
        A short box (the phone case): the answer surface no longer fits, so it scrolls inside the card while the Skip /
        Submit footer stays pinned and visible. Regression guard for the off-screen-button bug.
      </p>
      <ModeBlock label="options · single · short" payload={SINGLE_PAYLOAD} height={300} mobile />
      <ModeBlock label="options · multi · short" payload={MULTI_PAYLOAD} height={300} mobile />

      <h2
        className="mono text-caption font-semibold"
        style={{ color: "var(--fg-3)", textTransform: "uppercase", marginBottom: "var(--sp-2)" }}
      >
        GitHub commit overflow guard
      </h2>
      <div
        data-mobile-github-fixture
        style={{
          width: "100%",
          padding: "var(--sp-3)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-raised)",
          overflow: "hidden",
        }}
      >
        <GithubEventCardMessage content={COMMIT_CARD} />
      </div>
    </div>
  );
}
