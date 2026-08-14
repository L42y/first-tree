---
id: opentag-entry-agent-materialization
description: Validate the /opentag journey end to end — strict OAuth return, local draft, one atomic Agent create on a Computer-supported runtime, readiness and lost-response recovery, the focused Feishu handoff, and terminal completion on real first use in Feishu.
areas: [cross-surface]
surfaces: [server, web, client]
---

# OpenTag Entry Agent Materialization

## Goal

Confirm that one member can go from an unauthenticated `/opentag` link to a
Feishu Bot connected to exactly one Agent and on to real first use in Feishu,
and that every interruption on the way leaves either nothing or that same
Agent — never a second one.

The deterministic pieces (URL parsing, eligibility classification, step
selection) belong to product tests. This case owns what only a live run can
answer: that the atomic create really writes the Agent, its Computer, its
runtime and its durable config together on a real Computer; that a real
provider mix does not dead-end; that a failed readiness read cannot walk the
member into creating another Agent through the workspace and onboarding gates;
and that the membership is stamped complete only by a Feishu Task genuinely
belonging to this Agent, which no mocked read can establish.

## Preconditions

- A disposable account on a deployment whose official Agent Template catalog is
  published, and whose `FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID` is
  configured. Without it, Template adoption fails at create time and the run
  measures configuration rather than product behavior.
- A real connected Computer. At least one pass must use a Computer whose ready
  runtime is **not** the service default — a Codex-only machine is the useful
  shape, because the historical defect was an Agent stuck on `claude-code`.
- Fresh browser state, and a way to fault-inject `/me`, the chat reads and the
  completion request independently (devtools request blocking is enough). Never
  reuse a developer's session or localhost login.
- Direct database read access for the Agent, its runtime config, the Feishu
  binding, the Task chat's metadata and the membership onboarding columns. UI
  text alone does not establish what was written.
- A disposable Feishu tenant with a real person able to message the Bot, since
  only real ingress creates the Task this journey ends on. Reuse the tenant
  hygiene rules in [feishu-agent-channel](feishu-agent-channel.md); never use a
  customer conversation.
- For the cross-Agent leg, a second disposable Agent in the same Team bound to
  its **own** Bot. One Agent binds at most one Bot, so the second Bot is what
  makes the two Tasks distinguishable at all.

## Operate

1. **Strict return.** Visit `/opentag` logged out, sign in through the ordinary
   OAuth path, and confirm the member lands back on `/opentag` exactly. Do the
   same for a solo signup (one personal Team created) and for a member who
   already has a Team (no second Team created). Also try a non-canonical entry
   such as `/opentag?agent=not-a-uuid`; it should become the bare entry rather
   than a page that can only fail.
2. **Nothing before the Computer.** Choose a Template and a name, continue to
   the Computer step, then go back and reload. No Agent, config or Template
   import may exist in the database at any point before Create Agent is pressed.
3. **Atomic create.** With the non-default Computer selected, create the Agent.
   Assert in the database, in one state: the Agent row, its `client_id`, a
   `runtime_provider` matching what that Computer reported ready, an
   `agent_configs` payload tagged with the same provider, and the Template's
   imported Team Resources and bindings. A row whose provider and config
   disagree is a failure even if the UI looks correct.
4. **Readiness.** Block `/me`, then create. The Agent must appear in the URL
   immediately — that URL is the only durable recovery anchor this route has —
   and the page must say the team could not be refreshed while offering a
   retry. The Feishu handoff must not be reachable in this state: no Bot
   registration, no QR, no binding request in the network log, because
   finishing here would leave the workspace still believing this member has no
   Agent. Confirm nothing offers to create another Agent either: no create
   action and no way back to the Template choice. Then **reload with `/me`
   still blocked**, and confirm the same Agent is still the subject, the retry
   is still there, and creation is still not on offer; a UUID that only lived
   in memory would be lost here and the bare entry would invite a second
   Agent. Unblock `/me`, retry, and confirm the readiness fact is now current
   and that only then does the Feishu step appear.
   Finally visit `/` and confirm the member is not sent into onboarding.
5. **Lost response.** Re-run the create against the same handle to simulate a
   response that never arrived. The retry must be refused rather than
   duplicating, and the Agent already owned under that handle may be offered by
   name — only when it is active, organization-visible and bound. Continuing
   must again wait for an authoritative `/me`.
6. **Feishu handoff.** Reach the Feishu step, start the Bot registration, and
   confirm the QR and its confirmation link. Confirm the surface calls the Bot
   connected only once the binding is genuinely reachable, and reports a
   connection error in words rather than colour alone.
7. **No completion before real use.** Through every step above, including a
   Bot that is provisioned and connected, confirm no onboarding completion or
   suppression stamp was written for this membership. A connected Bot is setup,
   not use.
8. **Terminal first use.** From the real Feishu tenant, send this Bot a private
   message (or an exact group mention) so ingress creates the Task. Confirm the
   browser converges without a reload: the entry reaches its terminal state,
   `members.onboarding_completed_at` and the `completed` suppression stamp are
   written exactly once, and the offered destination opens that Task's chat.
   Reload the entry and confirm it converges to the same state with no second
   Agent, no second chat, and no second stamp.
9. **Another Agent's task cannot finish this one.** With a second Agent bound to
   its own Bot in the same Team, drive that Bot's Task and confirm it does not
   complete the first Agent's membership. Repeat with the first Agent invited
   into the second Agent's Task as an internal collaborator: being a speaker in
   someone else's Feishu conversation must not count as this Agent's first use.
10. **Failure honesty.** Block the chat reads while the Task exists and confirm
    the entry neither completes nor claims the Agent is unused, and recovers
    once the reads succeed. Then block only the completion request and confirm
    the terminal state stays retryable and withholds the destination until the
    stamp lands.
11. **Narrow viewport.** Repeat the main path at 390 px; the current decision
    must stay on the first screen.

## Evidence

Database rows for the Agent, its config and its Feishu binding at each
checkpoint; the membership onboarding stamp columns before and after real first
use; the Task chat's `metadata` alongside the Agent's Bot binding id; the
request log around the create, the blocked `/me` and the blocked reads; and
screenshots of the readiness-failure state, the Feishu step and the terminal
state. Redact tokens, connect codes, Bot credentials and external member
identities.

## Expected

Exactly one Agent per completed journey. Every interruption leaves either
nothing created or that one Agent, reachable again. A Computer running a
non-default runtime completes without a dead end, and reaching a connected Bot
does not complete onboarding — only a real Feishu Task belonging to this exact
Agent does, exactly once, and a failed read never stands in for one.

## Limitations

This case qualifies the entry's own terminal boundary, not the transport that
produces it: the Feishu message bridge, Bot credential handling, and the
Template catalog have their own owners. An admin continuing a teammate's Agent
is out of scope — that member does not own the setup being stamped.
