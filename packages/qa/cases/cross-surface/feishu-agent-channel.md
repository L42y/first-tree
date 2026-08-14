---
id: feishu-agent-channel
description: Validate a Bot-bound Agent's Feishu registration, inbound message and attachment projection, agentic official lark-cli egress, and read-only Web task end to end.
areas: [cross-surface]
surfaces: [server, client, cli, web]
---

# Feishu Agent Channel

## Goal

Confirm that one disposable Feishu Bot belongs to exactly one First Tree Agent and that a real Feishu conversation uses
the canonical First Tree message, Inbox, attachment, and chat-history paths. The run must also prove that internal
collaborators cannot borrow the primary Agent's Bot identity and that the Web projection remains read-only.

## Preconditions

- Use an isolated First Tree organization, disposable Agent A and Agent B, and a disposable Feishu tenant/chat. Do not
  reuse customer conversations or an operator's logged-in browser/provider session.
- Run the exact target Server, Web and Client builds. Agent A must be bound to the Client, and the official `lark-cli`
  must be launchable on that machine. Keep Agent B unbound from this Bot.
- Use the official QR registration flow from Agent A's detail page. Retain only redacted binding/connection state;
  never capture the App Secret, access tokens, raw event payloads, attachment bytes, or private member lists.
- Confirm the QR consent keeps the `PersonalAgent` preset and explicitly requests only tenant scopes for messaging,
  documents/Drive/Wiki, Sheets, Base, Calendar and Tasks. The visible messaging bundle must include the sensitive
  `im:message.group_msg` permission. No user-identity scope may be requested or injected.
- Prepare a private chat and a group containing the Bot. Prepare messages with text, post formatting, an image, a small
  file, more than ten resources, and one resource that is unavailable or exceeds 10 MiB.
- Prepare disposable documents, spreadsheets, Base apps, calendars and tasks owned by or shared with the Bot. Record
  every created provider resource so it can be deleted during reset.

## Operate And Observe

- Start registration, observe QR ready, complete/deny/expire separate attempts, and cancel one attempt. Confirm the UI
  serializes polling, ignores stale generations, and converges to the persisted binding state. With two Server replicas,
  confirm only the lease owner holds the Channel connection and that lease loss fences the old connection. Confirm the
  stored granted-scope list equals the explicit tenant-scope bundle and does not claim implicit preset permissions.
- With an active Bot, start registration again without disconnecting it. Confirm the existing Channel and Bot-scoped CLI
  grant remain usable while the QR is pending; deny, expire and cancel attempts without changing the existing binding.
  Then select the existing Bot in Feishu, approve the scope update, and confirm the App ID is preserved while credentials,
  explicit scopes and the Channel connection are refreshed. Repeat by selecting a new Bot and confirm old chat mappings
  detach only after the replacement succeeds. Reject invalid credentials or a mismatched same-App Bot identity before
  cutover. After an expired attempt, start another and confirm late success or failure from the old attempt cannot change it.
- From Agent A's isolated official `lark-cli` environment, create, read, update and delete one disposable document,
  spreadsheet, Base app/record, calendar/event and task/comment or attachment. Confirm every operation uses the Bot/App
  identity rather than a user token and cannot access an unshared user-owned resource.
- In private chat, send a normal human message without `@`. Confirm one canonical message is created with typed Feishu
  Integration sender, external-author snapshot and exact message/thread/root/parent reference, and that Agent A is
  notified once. Redeliver the same event/message id and confirm no duplicate message or wake occurs.
- In group chat, send an unrelated unmentioned message, a textual look-alike mention, and an exact structured mention of
  this Bot. Only the exact structured mention may create a message, fetch member names/resources, react, update
  `lastEventAt`, or wake Agent A. A different Bot/App must fail closed rather than falling back to this binding.
- Reply directly to a message sent by this Bot without another `@`. Confirm Agent A wakes once in the existing bound
  task. Repeat against a human message and a different Bot's message, and with a parent lookup failure; those messages
  must cause no canonical, attachment, reaction, Task, Inbox, or `lastEventAt` side effect.
- Activate a thread once through an exact `@Bot`, then send later human messages in that thread without `@`. Confirm each
  continues the same task and wakes Agent A. Repeat activation through a direct reply to this Bot. Unmentioned messages
  in a different, never-activated thread must remain ignored. Restart the Server or move the lease between replicas and
  confirm activation survives because it is derived from canonical provider references rather than process memory.
- For a triggered thread message, confirm the Agent prompt automatically contains the preceding provider window in
  chronological order, capped at 20 messages and 64 KiB, with current/newer messages and already-present canonical
  preceding messages removed. For a triggered non-thread group message, confirm the equivalent cap is 10 messages.
  Historical images/files must render safe placeholders without downloads or new First Tree attachments/messages.
  Force permission denial, provider timeout, and an older Server without the endpoint; the current trigger must still
  wake with a stable unavailable marker and no credential/provider-body leakage. Hold a parent/history request open and
  confirm the timeout cancels the provider transport; a timed-out history page must not start another page request.
- Exercise text, post styles/links/code/mentions, image, file, audio and video. Confirm downloadable resources become
  existing First Tree attachment refs before wake, Web can preview/download them, and Agent A receives usable local
  materialized paths. Partial failure, unsupported cards/merged forwards, >10 refs and >10 MiB resources must preserve
  the message with explicit unavailable placeholders. Confirm the uploader actor is the Bot-scoped Integration, while
  the displayed author remains the Feishu human.
- Invite Agent B through the ordinary Agent collaboration path. Confirm normal bounded history/backfill applies and B
  can inspect the same canonical messages and attachments, but cannot obtain A's App Secret, record external intent, or send
  to this Feishu conversation.
- From Agent A, first record an outbound intent, then call the official `lark-cli` directly for a new message, reply,
  thread reply, Markdown/card and attachment. Confirm each first attempt creates exactly one immutable recipientless
  First Tree message through shared `sendMessage`, gives other speakers only `notify=false` context, and uses that
  message id as the Feishu idempotency key. Reusing the same message id with changed content, target, or media bytes must
  be rejected. Confirm the temporary credential environment is private, is available only to A, and is deleted after use.
- Open the bound task in Web. Confirm messages, author attribution and attachments remain readable, while direct message,
  rename, membership, join/leave and other structural mutations are absent and rejected by direct Web API calls. Personal
  read, pin and archive state must continue to work.
- Revoke the binding and confirm credentials are cleared, the Channel disconnects, chat bindings detach, and later
  ingress/resource/CLI operations fail closed without deleting historical canonical messages or attachments.
- Delete every disposable Feishu document, spreadsheet, Base app, calendar, event, task and attachment created by the
  run, then verify no provider-side test resource remains. Never use deletion scopes against pre-existing or shared
  non-test resources; provider cleanup must target only the run's recorded disposable resource identifiers.

## Expected Result

`PASS`: all real provider, permission, runtime, canonical history, attachment, authorization, idempotency and Web
read-only branches above are observed on the exact target with no user scope, cross-Bot, cross-Agent or duplicate
delivery, and all disposable provider resources are removed.

`FAIL`: a reproducible product defect creates/wakes on an unrelated unmentioned group message, fails to wake on a verified
Bot reply or activated-thread continuation, persists provider reference context as canonical history, attributes an
external human as a First Tree member, loses a triggered message when one resource fails, exposes A's Bot credential to
B, bypasses canonical message creation, duplicates a same-id send inside the provider window, or permits a Web structural
mutation.

`BLOCKED`: official QR creation, disposable tenant/chat, inbound provider connectivity, official `lark-cli`, a
provider-backed Agent turn, or the two-replica environment cannot be established. Deterministic product tests alone do
not satisfy this live case.

`INCONCLUSIVE`: only source, mocks, component tests, or partial provider evidence is available, or shared state makes the
observed event/credential ownership unattributable.

## Evidence

Keep redacted binding/lease/scope state, canonical message and Inbox identifiers, ignored-message `lastEventAt` evidence,
attachment metadata without bytes, Web screenshots, Agent-visible bounded reference/local-path excerpts, CLI
command/result classifications, and provider message ids.
Record exact build refs and Feishu/CLI versions. Redact App Secrets, tokens, full QR URLs, raw webhooks, external member
identifiers, private content, and local home paths. Clean up the disposable App/Bot, chats, organization and run-local
files after evidence capture.
