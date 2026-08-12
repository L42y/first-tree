---
id: first-chat-capability-degradation
description: Validate that a first chat with no connected repo, no Context Tree, and no local gh/glab completes a real non-repo task end to end and degrades only the operations that genuinely depend on a missing capability.
areas: [cross-surface]
surfaces: [web, server, client, runtime]
---

# First-chat Capability Degradation

## Goal

Confirm that a missing capability — no connected code repository, no Context Tree, no local `gh`/`glab` on the agent's
computer — removes only the operations that depend on it, and never becomes a gate on the first chat itself. A fresh
admin and an invited member must each be able to complete a concrete task that needs no repository, and the agent must
keep working from the user's messages, chat context, and pasted or attached content. The absence of a capability must
never by itself produce a prompt to bind, create, connect, or install anything. Only when the concrete result of the
current request genuinely depends on the capability may the agent name the blocked step and ask for the minimal input
or recovery action.

Deterministic tests own prompt composition and guidance-copy rendering. This case owns what those tests cannot prove:
that a real runtime, guided by the assembled prompt, behaves this way across a live first chat for both a team creator
and an invitee.

## Preconditions

- Use an isolated stack with one fresh admin account (who creates the team) and one invited-member account, each with
  an active agent on a connected computer.
- The team has **no connected code repository, no Context Tree, and no team resources**; the agent's computer has
  **no `gh` and no `glab` on PATH**. Verify these negatives before the run — a capability present by accident silently
  invalidates the case.
- Keep the target runtimes connected and observable; capture their full turn output. Do not let them receive unrelated
  work during the run.
- Prepare a concrete non-repo task per persona (for example: draft a plan, summarize pasted notes, or answer a
  how-to question from the conversation alone) and one genuinely repo-dependent follow-up per persona.

## Operate and observe

1. As the fresh admin, finish onboarding and land in the first chat. Send the prepared non-repo task as the first
   message. Verify the agent engages the task directly and completes it end to end from the message, the chat context,
   and any pasted or attached content. Quote the reply. Verify no part of the turn asks the user to bind a Context
   Tree, connect a repository, install a CLI, or install forge tooling, and that the agent does not stall waiting for
   any of those.
2. Repeat step 1 as the invited member in their own first chat. The same behavior must hold even though this member
   did not create the team and has no admin path to fix the missing capabilities — the agent must not route the
   invitee toward setup they cannot perform.
3. In each chat, send the prepared repo-dependent follow-up (for example: "summarize the open issues" or "review the
   latest changes in our repo"). Verify the agent states which step is blocked by the missing capability and asks for
   the minimal input or recovery action. The ask must accept whatever the user can already provide — a plain local
   directory path, pasted content, an attachment, or a repository URL — and must not demand that the user create a git
   repository, connect a forge, or install anything first.
4. Provide the minimal input the agent asked for (for example a plain directory path or pasted file contents, not a
   connected repo) and verify the agent proceeds with the task from that input rather than re-asking for setup.
5. Exercise the remaining boundaries: ask for one Tree-dependent operation (for example "what did we decide about X?")
   and one forge-dependent operation (for example "open a PR for this"). Each must degrade to a statement of the
   blocked step plus a minimal-input alternative (answer from pasted decision notes; prepare the change locally and
   hand back a diff or instructions), never a blanket refusal and never a setup demand as the price of continuing.
6. Verify unrelated capabilities are untouched by the absences: ordinary chat, multi-participant addressing, and local
   file work on the connected computer all keep functioning in the same chats.
7. Repeat the key turns at a narrow phone viewport: the agent's blocked-step asks and minimal-input options remain
   fully readable and actionable, the composer stays usable, and no capability prompt overflows or traps the
   conversation.

## Evidence

A credible result quotes the actual agent replies for each persona: the completed non-repo task, each blocked-step
ask, and the continuation after minimal input was provided. For every capability claimed to be absent, show the
boundary evidence that proves it (no connected repo or Context Tree for the team, `gh`/`glab` not found on the agent
host) alongside the turn that depended on it. Capture desktop and narrow-viewport screenshots of the first chat,
including at least one blocked-step ask with its minimal-input options. Keep task content synthetic; do not retain
real repository contents, tokens, or private identifiers.

## Expected result

`PASS`: both personas complete a real non-repo task in the first chat with zero setup prompts; every
capability-dependent request degrades to an accurate blocked-step statement plus a minimal-input ask that accepts a
plain directory, pasted content, an attachment, or a URL; the agent proceeds once that input is given; unrelated
capabilities keep working; desktop and narrow viewports stay usable.

`FAIL`: any turn that asks the user to bind, create, connect, or install something as a precondition for an
independent task; a blanket refusal where a minimal-input alternative exists; a blocked-step ask that names the wrong
capability or demands a git repo or installation first; the invitee being routed to admin-only setup; or a degraded
capability leaking into unrelated operations.

`BLOCKED`: the stack cannot produce a team with all three capabilities absent, or the runtimes cannot be observed.

`INCONCLUSIVE`: prompt or component tests exist, but the assembled behavior was not observed in a live Web chat.
