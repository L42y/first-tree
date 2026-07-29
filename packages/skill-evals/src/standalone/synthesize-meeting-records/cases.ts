import type { MeetingRecordsEvalCase } from "./types.js";

const NATURAL_PROMPT =
  "Synthesize the meeting records described by source-artifacts/bundle.json. Save the validated destination-neutral packet as meeting-analysis-output.json.";

export const SYNTHESIZE_MEETING_RECORDS_CASES: readonly MeetingRecordsEvalCase[] = [
  {
    expected: {
      blockBeforeRawRead: false,
      categories: ["action", "blocker", "decision", "plan", "progress", "risk"],
      forbiddenTerms: [],
      itemCount: 6,
      rawCanaries: ["verbatim-canary-six-314159"],
      requiredTerms: ["label", "four", "pilot", "sample", "export", "ocr"],
      settlement: "confirmed",
      status: "complete",
    },
    fixture: { mode: "six-categories" },
    id: "meeting-records-six-category-synthesis",
    prompt: NATURAL_PROMPT,
  },
  {
    expected: {
      blockBeforeRawRead: false,
      categories: ["decision"],
      forbiddenTerms: ["option alpha", "verbatim-canary-alpha-271828"],
      itemCount: 1,
      rawCanaries: ["verbatim-canary-alpha-271828", "verbatim-canary-beta-161803"],
      requiredTerms: ["option beta"],
      settlement: "confirmed",
      status: "complete",
    },
    fixture: { mode: "later-override" },
    id: "meeting-records-later-override",
    prompt: NATURAL_PROMPT,
  },
  {
    expected: {
      blockBeforeRawRead: false,
      categories: ["action", "decision", "risk"],
      forbiddenTerms: [],
      itemCount: 3,
      rawCanaries: ["verbatim-canary-ai-141421"],
      requiredTerms: ["index", "prototype", "privacy"],
      settlement: "uncertain",
      status: "needs-confirmation",
    },
    fixture: { mode: "ai-only" },
    id: "meeting-records-ai-only-uncertain",
    prompt: NATURAL_PROMPT,
  },
  {
    expected: {
      blockBeforeRawRead: true,
      categories: [],
      forbiddenTerms: [],
      itemCount: 0,
      rawCanaries: ["verbatim-canary-partial-173205"],
      requiredTerms: [],
      settlement: "none",
      status: "blocked-source",
    },
    fixture: { mode: "partial-source" },
    id: "meeting-records-partial-source-blocked",
    prompt: NATURAL_PROMPT,
  },
];
