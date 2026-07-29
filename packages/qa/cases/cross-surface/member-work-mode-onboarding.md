---
id: member-work-mode-onboarding
description: Validate that an invited member can start with a personal First Tree agent, an existing Team agent, or BYO Claude Code/Codex.
areas: [cross-surface]
surfaces: [server, web, cli, client]
---

# Member Work-Mode Onboarding

## Goal

Confirm the three role-correct member paths across server and web:

- **Personal First Tree agent** connects the member's computer, creates their agent, then starts an Agent Chat.
- **Team agent** starts an Agent Chat with an agent the team already runs, without local setup.
- **Claude Code or Codex** receives one self-contained prompt that connects the computer, enables Team Context, and
  completes onboarding without creating a First Tree agent or Agent Chat.

Deterministic tests own rendering, readiness gates, picker filtering/pagination, and copy. This case owns the live
boundaries those tests cannot prove: the real Team-agent kickoff, the real Computer connection, the exact context
handoff for the selected Team/provider/checkout, completion stamps, reload behavior, and absence of accidental agent or
chat creation on BYO.

## Preconditions

- An isolated server stack with two users in one organization that has an active code-repository Team resource and a
  populated, bound Context Tree:
  - **Owner**: admin or member with a connected client and an active org-visible (`visibility=organization`) non-human
    agent bound to a live runtime.
  - **Invitee**: a fresh member (joined via invite link) with no connected client and no personal agent, so
    `currentOrgHasUsableAgent=true` and `currentOrgHasPersonalAgent=false` for the selected membership.
- A second fresh member in a Team with no org-visible agent.
- A third Team without a ready Context Tree/repository pair, for the BYO-readiness negative path.

## Scenario

1. **Choice always appears.** Accept the invite, sign in, and expect one recommended card, "Set up my First Tree
   agent", followed by "Start with a Team agent" and "Keep using Claude Code or Codex". The copy distinguishes the
   result and setup cost without introducing another product name. In a Team without ready Context, BYO remains
   visible but non-actionable and says it is not available yet; there is no Admin setup CTA.
2. **Team-agent path is complete.** Choose a Team agent. Expect the picker to list the owner's agent as
   "Run by 〈owner display name〉". Start chat. Expect navigation to First Tree Chat with no Computer connection or personal
   agent creation, the member-voice bootstrap, and a get-settled reply. Verify
   `onboarding_suppressed_reason='completed'` and `onboarding_completed_at` set. Reload `/` and `/onboarding`; neither
   reopens unfinished personal-agent setup. Re-running the same kickoff converges on the same chat without a duplicate
   bootstrap.
3. **BYO is independently complete.** With another fresh invitee, choose Claude Code or Codex. Expect one provider
   picker and one copied artifact to paste into that coding agent. The artifact contains a server-authored portable
   connection fallback plus the exact onboarding handoff
   `first-tree context enable --provider … --team … --yes --complete-onboarding`; the member is never sent to Terminal,
   a Connect Computer page, a second copy action, or a manual "Finish onboarding" button. Claude Code and Codex remain
   selectable regardless of the Web's global Computer/capability snapshot, because the coding-agent conversation may
   be on another computer.
4. **Verified automatic completion.** Complete the copied artifact from the target checkout. The CLI must verify the
   installed Plugin payload, exact provider + checkout + repository + Team binding, and a fresh connected activation
   response before idempotently stamping that membership's completion. The Web polls membership facts and changes to
   the completion state automatically; a Web refresh or a closed tab does not lose the server stamp. Verify reload
   does not reopen onboarding and no personal First Tree agent, kickoff chat, or Agent Chat was created. Corrupt the
   local Plugin or switch the exact Team/repository binding and verify completion is not stamped.
5. **Live readiness boundary.** Remove the active Team repository or Context Tree after the artifact was copied but
   before the CLI's final verification. The final live activation check must reject the stale handoff and the Web must
   remain in its waiting state. Restore readiness and rerun from the same coding-agent conversation.
6. **Provider-native trust.** Choose Codex. Expect the copied artifact and the page to explain that Codex may require
   `/hooks` approval in the coding-agent conversation. The member is not redirected to Terminal; after approval they
   continue in Codex and start a new session so Team Context loads.
7. **Provider boundary.** Start a Claude Code/Codex session in the enabled checkout. Verify it can read the exact Team
   Context snapshot according to policy, while the provider conversation does not appear in First Tree Chat.
8. **Settings after completion.** On desktop and mobile, Settings → Setup remains reachable. It does not infer the
   member's historical choice from current agent availability; it presents current Agent Chat access and Team Context
   capabilities neutrally. "Set up my agent" opens the real Team agent-creation surface instead of bouncing through
   completed onboarding.
9. **Offline disclosure.** Stop the owner's runtime, send another message in the Team-agent chat.
   Expect the offline notice to say the agent runs on a teammate's computer, with NO "Reconnect" action. As the owner
   in one of their own chats, the notice keeps the Reconnect action.
10. **No-Team-agent fallback.** In the Team without an org-visible agent, the Team-agent option is unavailable while
   the recommended personal path continues to connect-computer → create-agent → start-chat. BYO remains a separate
   choice when Team Context is ready and never traverses Create agent.

## Non-goals

Provider output quality, the landing-campaign trial path, and Admin onboarding are out of scope. The picker's
>100-agent pagination is covered by deterministic tests; this case does not require a 100-agent org.
