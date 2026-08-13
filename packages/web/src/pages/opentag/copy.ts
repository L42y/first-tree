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
  productName: "First Tree",
  railLabel: "Guided handoff",
  handoffLabel: "Your handoff",
  signOut: "Sign out",
} as const;

/**
 * The whole path, including the destination this entry hands off to. The rail
 * names every leg so the member can see how far Feishu still is.
 */
export const OPENTAG_RAIL_COPY: Record<OpenTagStepId, { title: string; rail: string }> = {
  "choose-agent": { title: "Create your Team Agent", rail: "Choose what it does" },
  "set-up-runtime": { title: "Set up its Runtime", rail: "Give it a place to work" },
  "connect-feishu": { title: "Add to Feishu", rail: "Connect one Bot" },
  "use-in-feishu": { title: "Use in Feishu", rail: "Start working there" },
};

/** Heading copy for the steps this entry renders. */
export const OPENTAG_STEP_COPY: Record<OpenTagStepId, { why: string; lead: string }> = {
  "choose-agent": {
    why: "Start with the work your team already has.",
    lead: "Pick the teammate you want in Feishu. Setting up where it runs comes after the Agent is clear.",
  },
  "set-up-runtime": {
    why: "Give your Agent one place to work.",
    lead: "Choose a connected Computer for this Agent. It stays on that Computer, and your other Computers are untouched.",
  },
  "connect-feishu": {
    why: "Connect your Agent to Feishu.",
    lead: "Confirm the Bot in Feishu while First Tree prepares everything your Agent needs in the background.",
  },
  // Says only what the Task itself establishes. The shell renders this heading
  // for the whole step, including while the completion stamp is still in flight
  // or has failed — so anything here that declared setup finished would sit
  // directly above copy saying it could not be finished.
  "use-in-feishu": {
    why: "Your Agent is working in Feishu.",
    lead: "Keep the conversation in Feishu — its work and history are here.",
  },
};

/**
 * The one heading this entry swaps at runtime.
 *
 * Connecting to Feishu has two halves that finish independently, and once the
 * Agent's own tools are the only thing left the ordinary heading would keep
 * asking the member for a confirmation they already gave. The lead names the
 * Bot only when it really is connected, so this never reports a half of the
 * handoff that has not happened.
 */
export function feishuToolsDelayedCopy(botReachable: boolean): { why: string; lead: string } {
  return {
    why: "One last part is taking longer.",
    lead: botReachable
      ? "Your Feishu Bot is connected. Your Agent's Computer is still preparing the tools it needs to reply."
      : "Your Agent's Computer is still preparing the tools it needs to reply in Feishu.",
  };
}

/** Member-facing strings for the two things Step 3 is waiting on. */
export const OPENTAG_FEISHU_READINESS_COPY = {
  panelPreparingTitle: "Preparing First Tree for Feishu…",
  panelPreparingLead: "You can stay on this page while both parts finish.",
  panelDelayedTitle: "Finishing Agent tools…",
  panelDelayedLead: "First Tree will keep checking this Computer.",
  botLabel: "Feishu Bot",
  toolsLabel: "Agent tools",
  recoveryTitle: "You are not stuck here.",
  recoveryLead: "Try the automatic setup again, or finish later and repair it from this Agent's settings.",
  tryAgain: "Try again",
  finishLater: "Finish later",
} as const;
