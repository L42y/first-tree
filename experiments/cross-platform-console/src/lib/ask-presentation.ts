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

const DECISION_LABELS = ["decision needed", "next step", "question", "the question", "what i need"];

const RECOMMENDATION_LABELS = ["my recommendation", "recommendation", "recommended", "recommended next step"];
const CHOICE_LABELS = ["choice", "the choice"];

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
  const label = withoutMarkdown.toLowerCase().split(/[:：;；]\s*/)[0];
  return label?.trim() ?? "";
}

function cleanLabeledParagraph(paragraph: string, labels: string[]): string {
  const match = paragraph.match(
    /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:@[A-Za-z0-9_-]+\s*)?([^:*_]{1,80}?)(?:\*\*|__)?\s*[:：;；]\s*([\s\S]*)$/,
  );
  if (!match) return paragraph;

  const label = match[1].trim().toLowerCase();
  const isRequestedLabel = labels.some((candidate) => label === candidate || label.startsWith(`${candidate} `));
  return isRequestedLabel ? match[2].replace(/^\s*(?:\*\*|__)\s*/, "").trim() : paragraph;
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
  const explicitChoices = sections.filter((section) => matches(section, CHOICE_LABELS));
  const recommendationSections =
    explicitChoices.length > 0
      ? explicitChoices
      : sections.filter((section) => matches(section, RECOMMENDATION_LABELS));
  const reserved = new Set([...decisionSections, ...recommendationSections]);
  const contextSections = sections.filter((section) => !reserved.has(section) && matches(section, CONTEXT_LABELS));

  let decision = decisionSections.map((section) => cleanLabeledParagraph(section, DECISION_LABELS)).join("\n\n");
  if (!decision) {
    decision = sections.find((section) => section.includes("?")) ?? sections[sections.length - 1];
  }

  const summaryParts = new Set([decision, ...recommendationSections]);
  const hasMore = sections.some((section) => !summaryParts.has(section));

  return {
    decision,
    recommendation:
      recommendationSections.length > 0
        ? recommendationSections
            .map((section) => cleanLabeledParagraph(section, [...RECOMMENDATION_LABELS, ...CHOICE_LABELS]))
            .join("\n\n")
        : null,
    context: contextSections,
    hasMore,
  };
}
