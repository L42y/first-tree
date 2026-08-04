import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button.js";

export const ONBOARDING_ORIENTATION_CONTINUE_MESSAGE = "I'm ready. Please help me get started with First Tree.";

const CHAPTERS = [
  {
    id: "multi-agent",
    title: "Multi-agent collaboration",
    summary: "Specialists work in parallel",
    transcript:
      "Your lead agent can split independent work into focused chats, so several specialists can make progress at the same time while the original chat stays your map.",
  },
  {
    id: "context-tree",
    title: "Context Tree",
    summary: "Shared decisions, available to every agent",
    transcript:
      "The Context Tree keeps durable decisions, constraints, ownership, and relationships in one shared memory so future agents begin with the team's settled context.",
  },
  {
    id: "github",
    title: "GitHub automation",
    summary: "PR updates return to the work",
    transcript:
      "When your team explicitly authorizes GitHub access, pull request checks, reviews, and merge activity can flow back into the chat where the work is happening.",
  },
  {
    id: "security",
    title: "Data & security",
    summary: "Local work, visible sharing, explicit access",
    transcript:
      "Agents work through the computer connected to them. First Tree Cloud receives the conversations, attachments, and work status your team can see. GitHub access is limited to repositories your team explicitly authorizes. First Tree does not silently bulk-upload repositories a local agent can access.",
  },
] as const;

type ChapterId = (typeof CHAPTERS)[number]["id"];

export type OnboardingOrientationProps = {
  completed: boolean;
  continuing: boolean;
  onContinue: () => void | Promise<void>;
};

export function OnboardingOrientation({ completed, continuing, onContinue }: OnboardingOrientationProps) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(!completed);
  const [selectedId, setSelectedId] = useState<ChapterId | null>(null);

  useEffect(() => {
    if (completed) setExpanded(false);
  }, [completed]);

  const selected = CHAPTERS.find((chapter) => chapter.id === selectedId) ?? null;

  if (!expanded) {
    return (
      <section
        aria-labelledby={titleId}
        data-onboarding-orientation="completed"
        className="mt-3 flex flex-col border border-border bg-muted/30 sm:flex-row sm:items-center"
        style={{ gap: "var(--sp-2)", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--radius-input)" }}
      >
        <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-2)" }}>
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary"
            aria-hidden="true"
          >
            <Play className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-label font-medium">
              First Tree introduction · About 90 seconds
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => setExpanded(true)}
        >
          Watch again
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      data-onboarding-orientation={completed ? "review" : "pending"}
      className="mt-3 overflow-hidden border border-border bg-background"
      style={{ borderRadius: "var(--radius-panel)" }}
    >
      <div className="flex flex-col" style={{ gap: "var(--sp-1)", padding: "var(--sp-4)" }}>
        <div className="flex flex-wrap items-start" style={{ gap: "var(--sp-2)" }}>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-title font-semibold">
              {selected?.title ?? "See how First Tree works"}
            </p>
            <p className="text-body text-muted-foreground">
              {selected?.summary ?? "Pick a short chapter, or skip straight to work. About 90 seconds total."}
            </p>
          </div>
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => setSelectedId(null)}
            >
              Choose another chapter
            </Button>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="border-t border-border" style={{ padding: "var(--sp-4)" }}>
          <div
            className="aspect-video flex items-center justify-center border border-border bg-muted/40 text-center"
            style={{ borderRadius: "var(--radius-input)", padding: "var(--sp-4)" }}
            aria-live="polite"
          >
            <div className="flex max-w-prose flex-col items-center" style={{ gap: "var(--sp-2)" }}>
              <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true">
                <Play className="size-4" />
              </span>
              <p className="text-label font-medium">{selected.title}</p>
              <p className="text-body text-muted-foreground">{selected.summary}</p>
              <span className="mono text-caption text-muted-foreground">Video placeholder</span>
            </div>
          </div>

          <details className="group mt-3 border-t border-border pt-3">
            <summary className="text-label inline-flex min-h-11 cursor-pointer items-center font-medium">
              Read transcript
              <ChevronDown className="ml-2 size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <p className="text-body mt-2 text-muted-foreground">{selected.transcript}</p>
          </details>

          {!completed ? (
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                variant="cta"
                className="min-h-11"
                disabled={continuing}
                onClick={() => void onContinue()}
              >
                {continuing ? "Starting…" : "Start my first task"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 border-y border-border sm:grid-cols-2">
            {CHAPTERS.map((chapter, index) => (
              <button
                key={chapter.id}
                type="button"
                data-orientation-chapter={chapter.id}
                onClick={() => setSelectedId(chapter.id)}
                className="min-h-11 border-0 border-b border-border bg-transparent p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:border-r"
              >
                <span className="flex items-start" style={{ gap: "var(--sp-2)" }}>
                  <span
                    className="mono text-caption flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="text-label block font-medium">{chapter.title}</span>
                    <span className="text-caption hidden text-muted-foreground sm:block">{chapter.summary}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          {!completed ? (
            <div className="flex justify-end" style={{ padding: "var(--sp-4)" }}>
              <Button
                type="button"
                variant="cta"
                className="min-h-11"
                disabled={continuing}
                onClick={() => void onContinue()}
              >
                {continuing ? "Starting…" : "Skip introduction and start"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
