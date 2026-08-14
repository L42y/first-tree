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
  "use-in-feishu": { title: "Ready in Feishu", rail: "Feishu handoff" },
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
  // Purely descriptive, because it is the one heading this step has. Directing
  // an action here would keep asking for a confirmation that may already be
  // done — or, when the Bot has failed, one the member cannot give at all.
  "connect-feishu": {
    why: "Add OpenTag to Feishu",
    lead: "Connect its bot while your agent prepares the tools it needs to work in Feishu.",
  },
  "use-in-feishu": {
    why: "Your agent is ready",
    lead: "Open Feishu and start working with your agent whenever you're ready.",
  },
};

/** Member-facing strings for the two things Step 3 is waiting on. */
export const OPENTAG_FEISHU_READINESS_COPY = {
  botLabel: "Feishu bot",
  toolsLabel: "Agent tools",
  recoveryTitle: "You are not stuck here.",
  recoveryLead: "Try the automatic setup again, or finish later and repair it from this agent's settings.",
  // When there is nothing left for the automatic setup to do, leaving is the
  // only honest offer.
  recoveryLeadFinishOnly: "Finish later and pick this up from this agent's settings whenever you're ready.",
  tryAgain: "Try again",
  finishLater: "Finish later",
} as const;
