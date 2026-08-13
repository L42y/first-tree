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
never by itself produce a prompt to bind, create, connect, or install anything — in the first chat or in any ordinary
later chat. Only when the concrete result of the
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
  how-to question from the conversation alone) whose completed result can record a lasting cross-module decision,
  one genuinely code-dependent follow-up per persona (for example: review the latest local changes, or trace a named
  module), and one forge-dependent operation per persona (for example: list open issues, read checks, or fetch PR
  metadata).

## Operate and observe

1. As the fresh admin, land in the first chat and complete or skip the Orientation surface. Per the onboarding
   kickoff contract the Orientation bootstrap is silent: it renders no agent opener and does not wake the agent by
   itself — verify no opener has appeared. Then send a generic taskless continuation (for example "I'm ready.")
   addressed to the agent; that ordinary visible human message is what wakes the agent into the welcome flow.
   Observe the response: it must be a brief readiness statement plus exactly one tracked goal ask, with zero
   repo/path/URL/binding/setup/auth/install wording and zero offered task options. Quote the opener. Then reply to
   the goal ask with the prepared non-repo task.
2. Verify the agent engages the task directly and completes it end to end from the message, the chat context, and any
   pasted or attached content. Quote the reply. Verify no part of the turn asks the user to bind a Context Tree,
   connect a repository, install a CLI, or install forge tooling, and that the agent does not stall waiting for any
   of those. Then check the bridge: whatever single next step the agent offers must follow from the completed task
   itself — an adjacent verification or implementation step tied to the user's goal. Even when the completed result
   records a lasting cross-module decision, no proactive Context Tree build or setup offer and no proposed separate
   tree chat may appear; only an explicit user Tree request may route to tree work.
3. Repeat steps 1–2 as the invited member in their own first chat. The same opener, task, and bridge behavior must
   hold even though this member did not create the team and has no admin path to fix the missing capabilities —
   neither the opener nor any later turn may route the invitee toward setup they cannot perform, and a result that
   records a lasting cross-module decision still earns no proactive Context Tree offer.
4. In each chat, send the prepared code-dependent follow-up (for example: "review the latest local changes" or
   "trace the checkout recovery module"). Verify the agent states which step is blocked by the missing capability and
   asks for the minimal input or recovery action. The ask must accept whatever the user can already provide — a plain
   local directory path, pasted content, an attachment, or a repository URL — and must not demand that the user
   create a git repository, connect a forge, or install anything first. Keep forge-only operations (open issues,
   checks, PR metadata) out of this step; they belong to step 6.
5. Provide the minimal input the agent asked for (for example a plain directory path or pasted file contents, not a
   connected repo) and verify the agent proceeds with the task from that input rather than re-asking for setup.
6. Exercise the remaining boundaries: make one explicit Context Tree request (for example "Read the Context Tree
   and tell me what it records about our release policy") and one forge-dependent operation (for example "open a PR
   for this" or "summarize the open issues"). For the Tree request the agent must state only that this Tree read
   cannot be completed because no Tree is bound — it must not prompt the user to bind or create a Tree, and it may
   continue the independent analysis from pasted decision notes. The forge step is where the missing `gh`/`glab`
   shows its boundary: the agent must degrade to a statement of the blocked step plus a minimal-input alternative
   (prepare the change locally and hand back a diff or instructions), and only that step is blocked. Neither may
   be a blanket refusal nor a setup demand as the price of continuing.
7. Verify unrelated capabilities are untouched by the absences: ordinary chat, multi-participant addressing, and local
   file work on the connected computer all keep functioning in the same chats.
8. Open a real, fresh ordinary chat — a new non-onboarding chat, not another turn inside the team's first chat, so no
   welcome bootstrap is in play. Send a concrete non-repo task that the conversation alone can answer and verify the
   agent completes it directly end to end: no onboarding opener, no goal ask, and zero bind/create/connect/install
   prompts. Even when the result records a lasting cross-module decision, no proactive Context Tree build or setup
   bridge appears. Then send the code-dependent request and the forge-dependent request in that chat and verify the
   same narrowing holds: the code-dependent request degrades to the same one-minimal-input ask (a plain local
   directory path, pasted content, an attachment, or a repository URL — never demanding that the user create, bind,
   or connect a repository first), and the forge-dependent request names only the missing forge capability for that
   one step.
9. Repeat the key turns at a narrow phone viewport: the onboarding opener's goal ask, the agent's blocked-step asks,
   and the minimal-input options remain fully readable and actionable, the composer stays usable, and no capability
   prompt overflows or traps the conversation.

## Evidence

A credible result quotes the actual agent replies for each persona: the silent Orientation surface followed by the
taskless continuation, the onboarding opener with its tracked goal ask, the completed non-repo task with its
goal-tied bridge, each blocked-step ask, and the continuation after minimal input was provided. For both first-chat
personas and for the ordinary chat, quote the completed result and whatever followed it to show that no proactive
Context Tree build or setup bridge appeared even when the result recorded a lasting cross-module decision. For every
capability claimed to be absent, show the boundary evidence that proves it (no connected repo or Context Tree for the
team, `gh`/`glab` not found on the agent host) alongside the turn that depended on it. Capture desktop and
narrow-viewport screenshots of the first chat, including the onboarding opener with its tracked goal ask and at least
one blocked-step ask with its minimal-input options, plus the ordinary-chat non-repo task completion. Keep task
content synthetic; do not retain real repository contents, tokens, or private identifiers.

## Expected result

`PASS`: the Orientation bootstrap stays silent and each taskless first chat opens only after a generic taskless
continuation, with a brief readiness statement plus exactly one tracked goal ask carrying no
repo/path/URL/binding/setup/auth/install wording and no offered task options; both personas then complete a real
non-repo task in the first chat with zero setup prompts; no completed result — even one recording a lasting
cross-module decision — is followed by a proactive Context Tree build or setup offer, in either first chat or in the
ordinary chat; a real fresh non-onboarding chat under the same absences likewise completes a concrete non-repo task
directly, with no onboarding opener and zero setup prompts, and degrades its code-dependent follow-up to the
same one-minimal-input ask; a code- or
forge-dependent request degrades to an accurate blocked-step statement plus a minimal-input ask that accepts a
plain directory, pasted content, an attachment, or a URL, and the agent proceeds once that input is given; an
explicit Context Tree read produces only the statement that this read cannot be completed because no Tree is
bound, with no bind/create prompt; unrelated capabilities keep working; desktop and narrow viewports stay usable.

`FAIL`: any turn that asks the user to bind, create, connect, or install something as a precondition for an
independent task; an onboarding opener that appears without a human continuation, or one that carries
repo/path/URL/binding/setup/auth/install wording or offers preset task options; a proactive Context Tree build or
setup offer appearing after any ordinary result, even one recording a lasting cross-module decision; an ordinary
non-onboarding chat that re-runs the onboarding opener or goal ask; a blanket refusal where a minimal-input
alternative exists; a blocked-step ask that names the wrong
capability or demands a git repo or installation first; the invitee being routed to admin-only setup; or a degraded
capability leaking into unrelated operations.

`BLOCKED`: the stack cannot produce a team with all three capabilities absent, or the runtimes cannot be observed.

`INCONCLUSIVE`: prompt or component tests exist, but the assembled behavior was not observed in a live Web chat.
