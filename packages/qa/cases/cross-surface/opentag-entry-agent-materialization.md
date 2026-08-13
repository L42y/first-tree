---
id: opentag-entry-agent-materialization
description: Validate the /opentag journey end to end — strict OAuth return, local draft, one atomic Agent create on a Computer-supported runtime, readiness and lost-response recovery, and the focused Feishu handoff without onboarding completion.
areas: [cross-surface]
surfaces: [server, web, client]
---

# OpenTag Entry Agent Materialization

## Goal

Confirm that one member can go from an unauthenticated `/opentag` link to a
Feishu Bot connected to exactly one Agent, and that every interruption on the
way leaves either nothing or that same Agent — never a second one.

The deterministic pieces (URL parsing, eligibility classification, step
selection) belong to product tests. This case owns what only a live run can
answer: that the atomic create really writes the Agent, its Computer, its
runtime and its durable config together on a real Computer; that a real
provider mix does not dead-end; and that a failed readiness read cannot walk
the member into creating another Agent through the workspace and onboarding
gates.

## Preconditions

- A disposable account on a deployment whose official Agent Template catalog is
  published, and whose `FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID` is
  configured. Without it, Template adoption fails at create time and the run
  measures configuration rather than product behavior.
- A real connected Computer. At least one pass must use a Computer whose ready
  runtime is **not** the service default — a Codex-only machine is the useful
  shape, because the historical defect was an Agent stuck on `claude-code`.
- Fresh browser state, and a way to fault-inject `/me` (devtools request
  blocking is enough). Never reuse a developer's session or localhost login.
- Direct database read access for the Agent, its runtime config and the Feishu
  binding. UI text alone does not establish what was written.

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
   retry. Confirm nothing offers to create another Agent from there: no create
   action and no way back to the Template choice. Then **reload with `/me`
   still blocked**, and confirm the same Agent is still the subject, the retry
   is still there, and creation is still not on offer; a UUID that only lived
   in memory would be lost here and the bare entry would invite a second
   Agent. Unblock `/me`, retry, and confirm the readiness fact is now current.
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
7. **No completion.** Confirm no onboarding completion or suppression stamp was
   written for this membership at any point.
8. **Narrow viewport.** Repeat the main path at 390 px; the current decision
   must stay on the first screen.

## Evidence

Database rows for the Agent, its config and its Feishu binding at each
checkpoint; the request log around the create and the blocked `/me`; and
screenshots of the readiness-failure state and the Feishu step. Redact tokens,
connect codes and Bot credentials.

## Expected

Exactly one Agent per completed journey. Every interruption leaves either
nothing created or that one Agent, reachable again. A Computer running a
non-default runtime completes without a dead end, and reaching a connected Bot
does not complete onboarding — real first use happens in Feishu.

## Limitations

Terminal first use in Feishu is out of scope here. This case does not qualify
the Feishu message bridge, Bot credential handling, or the Template catalog
itself; those have their own owners.
