---
id: member-work-mode-onboarding
description: Validate progressive invited-member onboarding, Team-agent quick start, and optional external Team Context access.
areas: [cross-surface]
surfaces: [server, web, cli, client]
---

# Progressive Member Onboarding

## Goal

Confirm that an invited member sees one recommended personal-agent journey first, can deliberately continue without a
personal agent, and only then sees the paths that are actually available:

- an existing Team agent starts a First Tree Chat without installing anything on the member's computer;
- Claude Code or Codex receives one self-contained prompt for external Team Context access;
- only the personal First Tree agent plus first-chat journey writes terminal onboarding completion.

Deterministic tests own rendering, readiness gates, picker filtering, and copy. This case owns the live boundaries those
tests cannot prove: the real Team-agent kickoff, exact membership stamps, the external Context handoff for one Team and
checkout, reload behavior, and the absence of accidental personal-agent or Chat creation.

## Preconditions

- An isolated server stack with an organization that has an active code-repository Team resource and a populated,
  bound Context Tree.
- **Owner**: an admin or member with a connected client and an active org-visible
  (`visibility=organization`) non-human agent bound to a live runtime.
- **Invitee**: a fresh invited member with no connected client and no personal agent.
- A second organization with no org-visible agent.
- A third organization whose Context Tree or active Team repository is not ready.

## Scenario

1. Accept the invite and sign in. The first member screen says the member joined the Team and recommends setting up a
   personal First Tree agent. It presents the connect-computer → create-agent → first-chat result without showing Team
   agent or Claude Code/Codex as peer choices.
2. Follow the recommended journey. Verify the existing personal-agent steps run unchanged, the first chat is created
   once, and the membership receives `onboarding_suppressed_reason='completed'` plus
   `onboarding_completed_at`. Reloading `/` does not reopen onboarding.
3. Repeat with a fresh invitee and choose **Continue without my own agent**. Only now should the page load and show
   eligible Team agents. Each agent discloses who manages it and that it uses that owner's connected computer and
   coding plan.
4. Start with the Team agent. Verify navigation to First Tree Chat without connecting the member's computer or creating
   a personal agent. The kickoff is idempotent and writes `onboarding_suppressed_reason='invitee_skip'` while leaving
   `onboarding_completed_at` null. Reloading `/` does not auto-open onboarding, but explicitly resuming setup still
   reaches the personal-agent journey.
5. Stop the owner's runtime and send another message in that Team-agent chat. The member sees that the agent runs on a
   teammate's computer and receives no owner-only reconnect action.
6. Repeat in the organization without an eligible Team agent. After **Continue without my own agent**, show that none is
   available without exposing an Admin setup action. If external Context access is ready, keep its secondary entry
   available; the recommended personal-agent journey remains resumable.
7. Open the external Context entry. Select Claude Code or Codex and copy exactly one server-authored artifact. The UI
   tells the member to paste it into the selected coding agent while that agent is open in the target repository
   checkout; it never sends the member to a Terminal screen or creates a second copy step.
8. Run the copied artifact from the target checkout. It may install or connect the normal First Tree Computer runtime
   internally, then enables and verifies the exact Team/provider/repository/checkout binding. The provider conversation
   remains outside First Tree Chat. No personal First Tree agent or onboarding kickoff chat is created, and
   `onboarding_completed_at` remains null.
9. Corrupt the local Plugin, change the checkout repository, remove the active Team repository, or unbind the Team
   Context before final activation. The fail-closed verification rejects stale or mismatched authority and does not
   claim success.
10. Return to First Tree after external setup. The member can use the product normally because onboarding auto-open was
    suppressed only by their explicit continue-without action, while the personal-agent journey remains resumable.
11. Verify the Context Tree entry already present in Settings → Setup remains unchanged and can issue a fresh
    settings-intent handoff without implying onboarding completion.

## Non-goals

Provider response quality, Admin onboarding, Settings information-architecture changes, the landing-campaign trial
path, and large-agent pagination are out of scope.
