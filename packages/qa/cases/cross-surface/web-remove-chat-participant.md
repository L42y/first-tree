---
id: web-remove-chat-participant
description: Verify Web Class C remove-participant closes membership, cancels inbox delivery, fences sessions, and refreshes roster for remaining speakers without deleting history.
areas: [cross-surface, web]
surfaces: [server, web, client]
---

# Web Remove Chat Participant

## Goal

Verify phase-1 group-chat remove participant: a speaking human removes another speaker from the desktop Participants rail, the server applies the canonical mutation (membership, inbox `cancelled`, session eviction fence, cron pause), and remaining participants see the roster update without a full page reload. History and `chat_user_state` remain.

## Preconditions

- Isolated or focused-local cell with Server + Web running against a migrated database that includes inbox status `cancelled`.
- Two human speakers and one non-human agent in the same group chat; the managing human of the agent is also a speaker when testing watcher downgrade.
- Authenticated Web session for a direct speaker (not a watcher-only viewer).

## Operate

- `operate web-ui`: open the chat, expand the right-sidebar Participants section, open the action menu on a non-self speaker row, confirm Remove.
- `operate http-api` (optional parallel): `DELETE /api/v1/chats/:chatId/participants/:agentId` as the same human; expect `200` with `{ chatId, targetAgentId, membershipKind }`.
- Negative paths: self-remove, watcher caller, target with `open_request_count > 0`, landing trial chat.

## Observe

- `observe web-ui`: confirm dialog states history is kept, send/@ stop, and that managing an agent may keep watcher observation; success toast is ordinary for detached, or “still observe” when `membershipKind=watching`; open-request failures show a clear unanswered-request toast.
- `observe http-api`: target is no longer a speaker; Human managers of remaining agents may be `watching`; pending/delivered inbox rows for the target are `cancelled`; non-human targets have an `evicted` session fence; active cron jobs for the removed agent pause with `agent_not_speaker` (or `owner_not_speaker` when the owner human is removed). Removing a non-human whose manager was watcher-only also drops that watcher and kicks their private me-chats with `chatId`.
- `observe runtime-event`: late `session:state` / `session:event` from the removed agent do not revive the session; a subsequent send from the removed agent is rejected.
- `observe web-ui`: other speakers’ roster / mention candidates refresh via `chat:updated` without requiring a hard reload; chat work-activity ordering does not jump solely because of the remove. A fully detached human (or a manager who lost their last watcher anchor) refreshes open `chat-detail` via targeted `me-chats:changed`.

## Expected Result

`PASS`: remove succeeds with correct membership outcome, delivery and session fences hold, history/`chat_user_state` survive, and Web roster refresh works for remaining audience (plus private me-chats refresh for a fully detached human).

`FAIL`: remove deletes history or user state, leaves pending inbox wakeable, allows late session revival, allows non-speaker callers, shows Remove to non-speaker supervisors, or hides self/read-only Remove incorrectly.

`BLOCKED`: cannot authenticate Web or migrate the inbox `cancelled` constraint.

## Evidence

Keep the DELETE response body, before/after membership and inbox status rows, session state after remove and after a late frame attempt, and a screenshot or DOM assertion of the confirm copy + toast. Redact tokens.
