import type { OpenTagStepId, OpenTagToolsPrep } from "./flow.js";

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
  // When the automatic setup cannot help — there is no Computer to prepare, or
  // the outstanding half is the member's own confirmation in Feishu — the only
  // honest offer left is to leave and pick it up from the Agent's own page.
  recoveryLeadFinishOnly: "Finish later and pick this up from this Agent's settings whenever you're ready.",
  tryAgain: "Try again",
  finishLater: "Finish later",
} as const;

/**
 * Everything the Feishu step says about itself, derived in one place from one
 * state.
 *
 * The step reports the same two facts three times over — a page heading, a
 * panel header, and the readiness rows — and three separate derivations of the
 * same thing is how they came to contradict each other. Deriving all of them
 * from the resolved state is what keeps "the automatic setup didn't start"
 * from appearing under "First Tree will keep checking this Computer".
 *
 * `heading` is null while the standing step heading is still the right
 * question, and `panel` is null once both halves are done and there is nothing
 * left to narrate.
 */
export function feishuStepCopy(
  botReachable: boolean,
  tools: OpenTagToolsPrep,
): {
  heading: { why: string; lead: string } | null;
  panel: { title: string; lead: string } | null;
} {
  const copy = OPENTAG_FEISHU_READINESS_COPY;
  const bothWaiting = { title: copy.panelPreparingTitle, lead: copy.panelPreparingLead };

  switch (tools.state) {
    case "unavailable":
      return {
        heading: {
          why: "This Agent has no Computer yet.",
          lead: "Feishu work runs on the Agent's own Computer. You can give it one from this Agent's settings.",
        },
        panel: {
          title: "Agent tools can't be prepared yet.",
          lead: "There is no Computer for this Agent to prepare them on.",
        },
      };
    case "ready":
      // The Computer is done. Anything that named it as outstanding would sit
      // directly above a row reporting it ready.
      return botReachable
        ? { heading: null, panel: null }
        : {
            heading: {
              why: "This is taking longer than usual.",
              lead: "Your Agent is ready. Feishu hasn't confirmed the Bot yet.",
            },
            panel: { title: "Waiting for Feishu…", lead: "Your Agent is ready. Confirming the Bot is the last part." },
          };
    case "recoverable":
      if (tools.reason === "failed") {
        // A request that never landed is not a duration, and nothing is being
        // checked in the background — so neither the heading nor the panel may
        // describe work in progress.
        return {
          heading: {
            why: "We couldn't start the setup.",
            lead: botReachable
              ? "Your Feishu Bot is connected. First Tree couldn't start preparing your Agent's Computer."
              : "First Tree couldn't start preparing your Agent's Computer.",
          },
          panel: {
            title: "Agent tools didn't start.",
            lead: "Trying again asks your Agent to prepare this Computer.",
          },
        };
      }
      return botReachable
        ? {
            heading: {
              why: "One last part is taking longer.",
              lead: "Your Feishu Bot is connected. Your Agent's Computer is still preparing the tools it needs to reply.",
            },
            panel: { title: copy.panelDelayedTitle, lead: copy.panelDelayedLead },
          }
        : {
            heading: {
              why: "This is taking longer than usual.",
              lead: "Your Agent's Computer is still preparing the tools it needs to reply in Feishu.",
            },
            panel: bothWaiting,
          };
    case "idle":
      // No Bot means no commitment and nothing being prepared. This step has
      // one decision left to offer, and narrating background work would invent
      // work nobody started.
      return { heading: null, panel: null };
    default:
      // Ordinary waiting, on one half or both.
      return {
        heading: null,
        panel: botReachable ? { title: copy.panelDelayedTitle, lead: copy.panelDelayedLead } : bothWaiting,
      };
  }
}
