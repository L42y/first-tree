# Onboarding Kickoff Contract

This note defines the current contract for web-created onboarding kickoff chats
and the adjacent campaign quickstart handoff.

## Current Contract

- `POST /api/v1/me/onboarding/kickoff` starts the user's first onboarding chat.
- The first message is task text sent through task `createChat`. Without the
  Orientation capability it remains an ordinary visible message and the agent
  sees the same text as the user. With Orientation enabled, Web replaces that
  marked row with the senderless Orientation surface while the stored text
  remains the agent's replayable conversational context.
- An ordinary onboarding client may send `orientation: 1` to opt into the
  current soft Orientation flow. The server then stores the bootstrap as
  silent, replayable context and adds the server-owned
  `firstChatOrientation` marker for Web rendering. Web must not expose the
  bootstrap body or attribute it to its human sender; it renders a senderless
  Orientation row instead. The next ordinary visible
  human message addressed to the original bootstrap target wakes that agent
  and carries the bootstrap as preceding context. A message addressed only to
  a participant added later remains an ordinary turn and does not consume the
  handoff. For a multi-recipient continuation, only the original target is
  eligible for exceptional bootstrap replay. The server marks that exact
  continuation and target, then advances the
  chat-scoped lifecycle to `continued`; Web treats the lifecycle as canonical
  completion even when the continuation is outside its cached message window.
  The bootstrap remains replayable beyond the generic silent-context window
  only for that marked first handoff. Afterward it is excluded from exceptional
  replay, including silent history backfilled to participants added later.
  Omitting `orientation` preserves the immediate-wake behavior for fresh
  kickoffs. If a legacy client reuses a keyed pending Orientation chat, the
  server promotes its existing bootstrap to one immediate wake and suppresses
  Orientation UI through a server-owned chat lifecycle. The immutable bootstrap
  marker is not rewritten. The lifecycle transition and the first ordinary
  human send share the keyed chat lock. If the promoted bootstrap is still
  pending, ownership of that wake transfers to the human continuation so the
  agent receives the bootstrap as preceding context and the user's actual
  message as the trigger.
  If the bootstrap was already claimed, the continuation is a normal next turn
  and wakes independently. Campaign actions and dedicated tree-setup kickoffs
  do not accept or render this Orientation marker.
- Skill activation comes from conversational message text delivered to the
  agent, bound resources, and skill descriptions. Orientation changes only the
  Web presentation of its stored bootstrap; the client must not append hidden
  onboarding directives from message metadata.
- Campaign quickstart starts through `POST /api/v1/me/landing-campaigns/start`.
  That server-owned path creates the trial chat, binds the managed trial prompt
  guardrail, and wakes the agent from visible task text. The campaign skill is
  not server-materialized: the kickoff message instructs the trial agent to
  clone the campaign's skill repo and run the named skill on the connected repo.
- Campaign quickstart may carry an anonymous `{ attemptId, variant }`
  attribution pair. The pair is stored only on the trial chat's JSON metadata
  and included in the internal campaign export; it does not change trial
  idempotency, quota, or runtime behavior and requires no schema migration.
- The first-chat endpoint is strict and rejects obsolete `campaign` and `kind`
  request fields.
- `POST /api/v1/orgs/:orgId/context-tree/setup-chat` is the only Context Tree
  setup kickoff entry. It requires an org admin, accepts only the selected
  agent, owns the canonical topic/bootstrap on the server, uses an initiating
  human + selected-agent `tree-setup` idempotency key, and never stamps
  onboarding completion. The chat is an ordinary private task chat; an org-wide
  key must not cross private-agent ownership boundaries.
- A retired `<organization>:tree-setup` chat is re-keyed and reused only when
  its complete membership is exactly the initiating human and selected agent,
  preserving safe Phase 1 history. Any ownership mismatch leaves the legacy
  chat untouched and creates the caller's scoped chat instead.
- A `/me/onboarding/kickoff` request may carry `stamp` to say how the
  membership's onboarding state is stamped once the kickoff chat exists:
  `"completed"` (default, same as the older `complete: true`), `"none"`
  (same as `complete: false`), or `"invitee_skip"` — the team-agent start.
  `"invitee_skip"` is used when a joining member starts their first chat with a
  teammate's org-visible agent instead of creating their own: it writes only
  the auto-open suppressor (`onboarding_suppressed_reason = "invitee_skip"`),
  never `onboarding_completed_at`, so the standard connect-computer →
  create-agent journey stays pending and resumable. `stamp` supersedes
  `complete` when both are present; the kickoff key stays the normal
  `<humanAgent>:<agent>:onboarding` key, so a team-agent start and a later
  personal-agent start-chat are distinct chats.
- A campaign result action carries `campaignAction: { campaign, repoSlug }`
  through either `/me/onboarding/kickoff` or the already-onboarded direct task
  path (`POST /api/v1/orgs/:orgId/chats`). Both endpoints compose the same
  server-owned `chats.onboarding_kickoff_key`, so re-entering an action link
  through either path reuses one launcher. Production Scan retains its stored
  `<humanAgent>:scan-fix:<repoSlug>` key so existing chats keep their durable
  idempotency identity without a data migration. `scanFixRepoSlug` is not an
  accepted request field. An onboarding action still stamps completion like any
  onboarding kickoff.
- The Agent's own Feishu CLI setup Task shares this column under the
  `<humanAgent>:<agent>:<client|"unbound">:feishu-cli` key, so the automatic
  OpenTag preparation, a reload, an extra tab, an explicit retry, and the
  permanent Agent Detail repair action all converge on one private conversation;
  moving the Agent to another Computer is a different machine to check and earns
  its own Task. The surface token stays last because `clients.id` is
  client-supplied text and this column is also read by suffix (below) — an
  arbitrary trailing segment could impersonate another namespace. Reuse is not
  inert: an explicit `retry` asks the Agent again inside that Task, because once
  it has taken the original request re-arming it wakes nobody, while every
  ensure-shaped call stays a no-op.
- A successfully created campaign action chat is best-effort recorded on the
  caller's matching trial-chat metadata. This keeps conversion measurement
  inside the existing trial-export authorization boundary; ordinary action
  chat content is never added to the cross-tenant export.
- Campaign action fields belong only to the signed-in Web DTO
  (`CreateWebTaskChat`). The agent SDK's `CreateTaskChat` type and
  `/api/v1/agent/chats` contract do not expose them; a raw agent request that
  attempts either field is rejected rather than silently receiving Web-user
  authority.

## Retired Contract Boundary

Historical server/client pairs used `metadata.systemSender:
"first_tree_onboarding"` plus optional `metadata.campaign` as an agent-only
activation directive.

Those request and prompt contracts are intentionally retired:

- Obsolete `kind`, `campaign`, and `scanFixRepoSlug` fields are rejected by the
  current strict schemas.
- `/me/onboarding/tree-setup/kickoff` is not registered; the canonical
  team-scoped setup endpoint is the only route.
- The client renders legacy onboarding metadata as ordinary message metadata; it
  does not append hidden instructions to the agent prompt. Campaign skill
  activation must not rely on a client-appended directive.
- Historical database rows whose `onboarding_kickoff_key` ends in `:tree` remain
  recognized by tree setup status reads so existing completed tree setup chats do
  not reappear as setup debt.

Do not reintroduce a compatibility shim that maps obsolete request fields, routes
campaign quickstart through onboarding kickoff, or turns historical onboarding
metadata into agent-only prompt text without a new product decision.
