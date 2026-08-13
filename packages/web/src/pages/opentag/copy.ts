import type { OpenTagStepId } from "./flow.js";

/**
 * Member-facing strings for the `/opentag` entry, kept out of the components
 * the same way `pages/onboarding/copy.ts` does — one place to read the whole
 * journey's voice, and one place to check it against the product vocabulary.
 *
 * Step ids are product concepts, never implementation words: the member reads
 * "Computer" and "Feishu", never "client", "bind", "runtime provider".
 */
export const OPENTAG_COPY = {
  productName: "OpenTag",
  railLabel: "OpenTag setup progress",
  signOut: "Sign out",
} as const;

/**
 * The whole path, including the destination this entry hands off to. The rail
 * names every leg so the member can see how far Feishu still is.
 */
export const OPENTAG_RAIL_COPY: Record<OpenTagStepId, { title: string; rail: string }> = {
  "choose-agent": { title: "Shape your agent", rail: "Focus & name" },
  "set-up-runtime": { title: "Set up its runtime", rail: "Computer & coding agent" },
  "connect-feishu": { title: "Add it to Feishu", rail: "Connect its bot" },
  "use-in-feishu": { title: "Start working together", rail: "First task" },
};

/** Heading copy for the steps this entry renders. */
export const OPENTAG_STEP_COPY: Record<OpenTagStepId, { why: string; lead: string }> = {
  "choose-agent": {
    why: "What should your agent do?",
    lead: "Choose the kind of work you want to delegate. We'll use the matching template as its starting setup, and you can refine it later.",
  },
  "set-up-runtime": {
    why: "Set up its runtime",
    lead: "Connect or choose the computer where your agent will work. We'll use an available coding agent on it.",
  },
  "connect-feishu": {
    why: "Add OpenTag to Feishu",
    lead: "Create the bot, then confirm it in Feishu.",
  },
  // Says only what the Task itself establishes. The shell renders this heading
  // for the whole step, including while the completion stamp is still in flight
  // or has failed — so anything here that declared setup finished would sit
  // directly above copy saying it could not be finished.
  "use-in-feishu": {
    why: "Send your first task",
    lead: "Send the bot a private message, or @mention it in a group. This page updates automatically.",
  },
};

export const OPENTAG_FIRST_TASK_COMPLETE_COPY = {
  why: "Your first task is ready",
  lead: "Keep the conversation in Feishu. You can follow the work and its full history here.",
} as const;
