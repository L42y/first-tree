import {
  type ContextDecision,
  type ContextDecisionEffect,
  type ContextDecisionEvidence,
  canonicalGitRepoIdentity,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { FirstTreeLogo } from "../first-tree-logo.js";

/**
 * How the four receipt effects read to a person. The label answers "what did
 * shared team context DO here" in the user's language; the raw enum never
 * reaches the screen. `confirmed` deliberately avoids "verified"/"correct" and
 * carries no success check — Tree content supported the direction, it did not
 * prove the result right.
 */
const EFFECT_LABELS: Record<ContextDecisionEffect, string> = {
  conflicted: "Conflict surfaced",
  redirected: "Approach changed",
  constrained: "Options narrowed",
  confirmed: "Direction supported",
};

/**
 * Agent-reported proof that the team's Context Tree shaped THIS answer.
 *
 * Placement is the whole point: it sits directly under the result being judged
 * (an agent's chat reply, or an ask's question body above the answer controls),
 * so the reader sees what team context changed at the moment they decide
 * whether to trust the result.
 *
 * Trust contract — the module states the outcome objectively ("Options
 * narrowed") because that is what the agent reports, but it is NOT a First Tree
 * verification:
 *   - the visual is a scoped Context Tree panel, never system/verified card
 *     chrome, and carries no success check or "verified" copy;
 *   - the collapsed state stays on user value; a short agent-attribution note
 *     lives at the bottom of the expanded sources, where a reader inspecting
 *     provenance needs it. That weakening is only valid while the receipt is
 *     still attached to its authoring agent's message — any future
 *     cross-message digest must re-state attribution up front.
 *
 * The whole compact panel is the disclosure target. Source rows lead with a
 * human-readable node + heading label; exact repository, commit and path stay
 * in the link/title and only repeat visibly when a safe source link cannot be
 * built.
 *
 * Rendering is gated on a strict parse upstream (`readContextDecisionMetadata`),
 * so a partial or unknown-version payload shows nothing at all rather than a
 * half-claim.
 */
export function ContextDecisionReceipt({
  receipt,
  gitlabInstanceOrigin = null,
}: {
  receipt: ContextDecision;
  /**
   * The Team's GitLab web origin, when connected. Used only to turn a GitLab
   * source into an exact-commit link; without a confident match the source
   * stays plain text rather than becoming a guessed (possibly dead) URL.
   */
  gitlabInstanceOrigin?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const conflict = receipt.effect === "conflicted";
  const sharedVersion = sharedEvidenceVersion(receipt.evidence);
  const sourceVersionCount = new Set(receipt.evidence.map(evidenceVersionKey)).size;

  return (
    <aside
      aria-label="Context Tree influence reported by the agent"
      className="text-body"
      style={{
        marginTop: "var(--sp-3)",
        borderRadius: "var(--radius-panel)",
        background: "var(--brand-bg)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="w-full min-h-11 text-left focus-visible:outline-none focus-visible:ring-1 ring-ring ring-offset-1"
        style={{ padding: "var(--sp-2_5)" }}
      >
        <div className="flex items-start" style={{ gap: "var(--sp-2)" }}>
          <FirstTreeLogo
            width={12}
            height={14}
            style={{ marginTop: "var(--sp-0_5)", flexShrink: 0, color: "var(--brand)" }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
              <span className="text-caption font-semibold" style={{ color: "var(--brand-dim)" }}>
                Context Tree
              </span>
              <span
                className="text-body font-semibold min-w-0 flex-1"
                style={{ color: conflict ? "var(--warning)" : "var(--fg)" }}
              >
                {EFFECT_LABELS[receipt.effect]}
              </span>
              {open ? (
                <ChevronUp aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--fg-3)" }} />
              ) : (
                <ChevronDown aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--fg-3)" }} />
              )}
            </div>
            <p className="leading-relaxed" style={{ marginTop: "var(--sp-1)", color: "var(--fg-2)" }}>
              {receipt.summary}
            </p>
          </div>
        </div>
      </button>
      {open ? (
        <div
          id={detailsId}
          style={{
            margin: "0 var(--sp-2_5)",
            padding: "var(--sp-2) 0 var(--sp-2_5)",
            borderTop: "var(--hairline) solid var(--border-faint)",
          }}
        >
          <ul className="flex flex-col" style={{ listStyle: "none", margin: 0, padding: 0, gap: "var(--sp-1)" }}>
            {receipt.evidence.map((evidence) => (
              <li key={`${evidence.repoUrl}@${evidence.commit}:${evidence.nodePath}`}>
                <EvidenceRow evidence={evidence} gitlabInstanceOrigin={gitlabInstanceOrigin} />
              </li>
            ))}
          </ul>
          <div className="text-caption" style={{ paddingTop: "var(--sp-1)", color: "var(--fg-3)" }}>
            {receipt.evidence.length === 1 ? "1 decision" : `${receipt.evidence.length} decisions`}
            {sharedVersion
              ? ` · Context Tree version ${sharedVersion.commit.slice(0, 7)}`
              : ` · ${sourceVersionCount} source versions`}
          </div>
          <p
            className="text-caption leading-relaxed"
            style={{
              marginTop: "var(--sp-2)",
              paddingTop: "var(--sp-2)",
              borderTop: "var(--hairline) solid var(--border-faint)",
              color: "var(--fg-3)",
            }}
          >
            Influence is agent-reported, not independently verified.
          </p>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * One cited node: a readable node + heading label links to the exact source.
 * Raw repository, commit and path are noise when that link is safe, so they
 * stay in its target/title; an unidentifiable forge falls back to visible
 * technical provenance instead of a guessed link.
 */
function EvidenceRow({
  evidence,
  gitlabInstanceOrigin,
}: {
  evidence: ContextDecisionEvidence;
  gitlabInstanceOrigin: string | null;
}) {
  const identity = canonicalGitRepoIdentity(evidence.repoUrl);
  const href = contextDecisionSourceHref(evidence, gitlabInstanceOrigin);
  const title = evidenceLabel(evidence);
  const sourceDetails = `${evidence.nodePath} · ${identity?.path ?? evidence.repoUrl} · ${evidence.commit.slice(0, 7)}`;

  const body = (
    <>
      <span className="text-label font-medium block" style={{ color: "var(--fg)" }}>
        {title}
      </span>
      {!href ? (
        <span className="mono text-caption block break-all" style={{ color: "var(--fg-3)" }}>
          {sourceDetails}
        </span>
      ) : null}
    </>
  );

  if (!href) {
    return (
      <div
        className="min-w-0 flex items-center"
        style={{ minHeight: "var(--sp-11)" }}
        title={`${evidence.nodePath} at ${evidence.commit}`}
      >
        {body}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${title}, source version ${evidence.commit.slice(0, 7)}`}
      className="flex min-w-0 items-center no-underline focus-visible:outline-none focus-visible:ring-1 ring-ring ring-offset-1"
      style={{ minHeight: "var(--sp-11)", gap: "var(--sp-2)", color: "inherit" }}
      title={`${evidence.nodePath} at ${evidence.commit}`}
    >
      <span className="min-w-0 flex-1">{body}</span>
      <ExternalLink aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--fg-3)" }} />
    </a>
  );
}

/**
 * Exact-commit file link, or `null` when the forge cannot be identified with
 * confidence. GitHub is recognized by host; a non-GitHub host only links when
 * it matches the Team's connected GitLab origin. Everything else stays plain
 * text — a broken link would undermine the one thing this module can promise:
 * the cited source is inspectable.
 */
export function contextDecisionSourceHref(
  evidence: ContextDecisionEvidence,
  gitlabInstanceOrigin: string | null,
): string | null {
  const identity = canonicalGitRepoIdentity(evidence.repoUrl);
  if (!identity) return null;
  const path = evidence.nodePath.split("/").map(encodeURIComponent).join("/");
  if (identity.host === "github.com") {
    return `https://github.com/${identity.path}/blob/${evidence.commit}/${path}`;
  }
  const gitlab = resolveGitLabRepositoryWebIdentity(evidence.repoUrl, gitlabInstanceOrigin);
  if (gitlab?.originMatchesConnection) {
    return `${gitlab.origin}/${gitlab.path}/-/blob/${evidence.commit}/${path}`;
  }
  return null;
}

function evidenceLabel(evidence: ContextDecisionEvidence): string {
  const parts = evidence.nodePath.split("/").filter(Boolean);
  const fileName = parts.at(-1)?.replace(/\.md$/i, "") ?? evidence.nodePath;
  const nodeName = humanizeNodeSegment(fileName.toLowerCase() === "node" ? (parts.at(-2) ?? fileName) : fileName);
  if (!evidence.heading || evidence.heading.toLocaleLowerCase() === nodeName.toLocaleLowerCase()) return nodeName;
  return `${nodeName} · ${evidence.heading}`;
}

function humanizeNodeSegment(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sharedEvidenceVersion(evidence: ContextDecisionEvidence[]): ContextDecisionEvidence | null {
  const first = evidence[0];
  if (!first) return null;
  const firstVersion = evidenceVersionKey(first);
  return evidence.every((item) => evidenceVersionKey(item) === firstVersion) ? first : null;
}

function evidenceVersionKey(evidence: ContextDecisionEvidence): string {
  const identity = canonicalGitRepoIdentity(evidence.repoUrl);
  const repo = identity ? `${identity.host}/${identity.path}` : evidence.repoUrl;
  return `${repo}\u0000${evidence.commit}`;
}
