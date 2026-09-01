/**
 * Ask bodies are intentionally self-contained, but equal-weight Markdown
 * turns them into a runtime log. This derives a human-first summary while
 * retaining the untouched body as collapsible background.
 */

export type AskPresentation = {
  /** The human's primary decision, normally one short paragraph. */
  decision: string;
  recommendation: string | null;
  /** Background paragraphs that should not lead the UI. */
  context: string[];
  /** True when the original body contains content beyond the summary. */
  hasMore: boolean;
};

const CONTEXT_LABELS = [
  "background",
  "constraints",
  "context",
  "current state",
  "current verified state",
  "details",
  "recap",
  "recent context",
  "status",
  "timeline",
  "what happened",
  "why this question exists",
];

const DECISION_LABELS = [
  "choice",
  "decision",
  "decision needed",
  "next step",
  "question",
  "the choice",
  "the question",
  "what i need",
];

const RECOMMENDATION_LABELS = ["my recommendation", "recommendation", "recommended", "recommended next step"];

function paragraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function paragraphLabel(paragraph: string): string {
  const withoutMentions = paragraph.replace(/(?:^|\s+)@[A-Za-z0-9_-]+/g, " ");
  const withoutMarkdown = withoutMentions
    .replace(/^#{1,6}\s*/, "")
    .replace(/[*_`>]/g, "")
    .replace(/^[-•]\s*/, "")
    .trim();
  const label = withoutMarkdown.toLowerCase().split(/[:：]\s*/)[0];
  return label?.trim() ?? "";
}

function matches(paragraph: string, labels: string[]): boolean {
  const label = paragraphLabel(paragraph);
  return labels.some((candidate) => label === candidate || label.startsWith(`${candidate} `));
}

export function buildAskPresentation(content: string): AskPresentation {
  const source = typeof content === "string" ? content.trim() : "";
  const sections = paragraphs(source);

  if (sections.length === 0) {
    return { decision: "", recommendation: null, context: [], hasMore: false };
  }

  const decisionSections = sections.filter((section) => matches(section, DECISION_LABELS));
  const recommendationSections = sections.filter((section) => matches(section, RECOMMENDATION_LABELS));
  const reserved = new Set([...decisionSections, ...recommendationSections]);
  const contextSections = sections.filter((section) => !reserved.has(section) && matches(section, CONTEXT_LABELS));

  let decision = decisionSections.join("\n\n");
  if (!decision) {
    decision = sections.find((section) => section.includes("?")) ?? sections[sections.length - 1];
  }

  const summaryParts = new Set([decision, ...recommendationSections]);
  const hasMore = sections.some((section) => !summaryParts.has(section));

  return {
    decision,
    recommendation: recommendationSections.length > 0 ? recommendationSections.join("\n\n") : null,
    context: contextSections,
    hasMore,
  };
}
