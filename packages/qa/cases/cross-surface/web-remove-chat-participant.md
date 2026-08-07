---
id: web-remove-chat-participant
description: Verify Web Class C remove-participant applies the owner-side / own-agent matrix, closes membership, cancels inbox delivery, fences sessions, and refreshes roster — with live Participants UI screenshots as required evidence.
areas: [cross-surface, web]
surfaces: [server, web, client]
---

# Web Remove Chat Participant

## Goal

Verify phase-1 group-chat remove participant under the **owner-side / own-agent** authorization matrix: Web exposes Remove only when chat-detail `canRemove` is true; the server applies the canonical mutation (membership, inbox `cancelled`, session eviction fence, cron pause); remaining participants see the roster update without a full page reload. History and `chat_user_state` remain.

## Authorization matrix (product truth)

- Caller must be a current **speaker**; self-remove is refused (leave / workspace-leave).
- Target must be a current **speaker**.
- `role='owner'` targets are **never** removable; the owner row must survive a failed attempt.
- Otherwise allow when **either**:
  - caller is **owner-side** (holds `role='owner'`, or shares the chat owner agent's `manager_id` — including when the owner row is a watcher); or
  - target is **non-Human** and shares the caller's `manager_id` (own-agent recall).
- Ordinary speakers must **not** remove unrelated Humans or Agents.
- Open-request guard uses durable request/resolution rows (Need You), **not** `chat_user_state.open_request_count`. Block with 409 only when a Human would **fully detach**; retained watcher after remove is allowed.

Web must use server-derived `participants[].canRemove`. Incomplete client inference must not invent a Remove.

## Preconditions

- Isolated or focused-local cell with Server + Web running against a migrated database that includes inbox status `cancelled` and resume-generation fences.
- Seed chats that cover: owner-side human removing Human + Agent; managing human recalling only their own Agent; bystander speaker with no removable unrelated rows; owner + self never showing Remove; watcher/read-only with no Remove.
- Authenticated Web session for each viewer under test.

## Operate

- `operate web-ui`: open the chat, expand the right-sidebar Participants section, open the action menu only on rows the matrix allows, confirm Remove.
- `operate http-api` (optional parallel): `DELETE /api/v1/chats/:chatId/participants/:agentId` as the same human; expect `200` with `{ chatId, targetAgentId, membershipKind }` when authorized, `403` when not, `409` + `OPEN_REQUEST_PENDING` on stranded open request + full detach.
- Negative paths: self-remove, watcher caller, owner target, bystander removing unrelated Human/Agent, full-detach Human with durable open request, landing trial chat.

## Observe

- `observe web-ui` (**required live screenshots** on this head — do not reuse prior evidence):
  1. Participants row menu showing Remove only where `canRemove` is true (owner-side / own-agent), and **no** Remove on owner / self / unrelated / watcher / read-only.
  2. Confirm dialog copy (history kept; send/@ stop; may keep watcher observation).
  3. Outcome toast — ordinary detached vs “Moved to watching”; unanswered-request toast on 409; “Not allowed” on 403.
- `observe http-api`: `GET /chats/:id` participant rows carry correct `canRemove`; after DELETE, target is no longer a speaker; Human managers of remaining agents may be `watching`; pending/delivered inbox rows for the target are `cancelled`; non-human targets have an `evicted` session fence with bumped resume generation; active cron jobs pause appropriately. Removing a non-human whose manager was watcher-only also drops that watcher and kicks their private me-chats with `chatId`.
- `observe runtime-event`: late `session:state` / `session:event` from the removed agent do not revive the session; a subsequent send from the removed agent is rejected; re-add cannot resume a pre-removal provider mapping without the new generation.
- `observe web-ui`: other speakers’ roster / mention candidates refresh via `chat:updated` without a hard reload. A fully detached human (or a manager who lost their last watcher anchor) refreshes open `chat-detail` via targeted `me-chats:changed`.

## Expected Result

`PASS`: matrix affordance matches `canRemove`, remove succeeds with correct membership outcome, delivery and session fences hold, history/`chat_user_state` survive, Web roster refresh works, and the three live screenshots above are attached for this exact head.

`FAIL`: UI invents Remove without `canRemove`, shows Remove on owner/self/unrelated/watcher, remove deletes history or user state, leaves pending inbox wakeable, allows late session revival, trusts `open_request_count` as authority, or blocks retained-watcher Humans solely because of a drifted counter.

`BLOCKED`: cannot authenticate Web or migrate the inbox `cancelled` / resume-generation constraints.

## Evidence

**Required:** live screenshots (Participants menu + confirm dialog + outcome/toast) for this exact head. Also keep DELETE response body, before/after membership and inbox status rows, session state after remove and after a late frame attempt. Redact tokens.
