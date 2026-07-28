---
id: agent-chat-archive-cli
description: Validate that a participating agent can archive a chat from the signed-in human's Active view through the CLI without changing membership or another participant's private view.
areas: [cross-surface]
surfaces: [cli, client, server, web, runtime]
---

# Agent chat archive CLI

## Goal

Confirm that `first-tree chat archive [chatId]` crosses the real CLI, SDK, agent-scoped HTTP, private
`chat_user_state`, realtime invalidation, and Workspace list boundaries correctly. The selected agent may archive only
a chat in which it is a speaker — the same structural scope exposed by `chat list` — while the resulting
`engagement_status = archived` belongs to the signed-in managing human. The operation must not archive the runtime
agent's row, another participant's view, or the chat globally.

Deterministic product tests own exact command registration, fallback selection, endpoint paths, response envelopes,
idempotence, and service-row assertions. This case owns the live boundaries those tests cannot prove: installed CLI
credentials and runtime-session delivery, private cross-device Workspace refresh, agent briefing behavior, and the
archive/revive sequence across a real message path.

## Preconditions

- Use the complete isolated QA cell with candidate CLI, Client/runtime, server, web, PostgreSQL, and temporary First
  Tree homes. Do not use an operator's installed CLI, existing chats, credentials, or hosted Workspace.
- Create user A with a runnable agent `worker-a`, user B with a runnable agent `worker-b`, and a shared chat in which
  `worker-a` speaks. Keep `worker-b` outside that chat. Give both humans live Workspace sessions; give user A a second
  session/device when available so the private realtime invalidation can be observed.
- Create a second chat in which both agents speak. This distinguishes participant authorization from ownership:
  a non-owner speaking agent remains eligible to archive for its own signed-in human.
- Capture redacted CLI stdout/stderr, agent-scoped HTTP method/path/status, relevant database rows, and WebSocket frame
  types. Never retain member JWTs, runtime-session tokens, cookies, or unrelated chat content.

## Operate and observe

- Run `first-tree chat list --agent worker-a` and retain the returned chat ids. Archive one with
  `first-tree chat archive <chatId> --agent worker-a`, then repeat the same command. Both calls succeed with one clean
  `{ok:true,data:{chatId,engagementStatus:"archived"}}` envelope and no human chatter on stdout.
- In a real `worker-a` session for another eligible chat, omit the id and run `first-tree chat archive`; verify
  `FIRST_TREE_CHAT_ID` selects the current chat. Outside a chat session, omitting the id fails locally with
  `NO_CHAT_CONTEXT`, exit `2`, and no HTTP request.
- Select `worker-b` against the chat where it is not a speaker. The server refuses the write; no engagement row for
  user B changes. Then use the shared chat where `worker-b` is a non-owner speaker and confirm it can archive that chat
  for user B. Ownership is not the archive gate; speaker membership is.
- Inspect private state after each success. Only the acting signed-in human's `(chat_id, human_agent_id)` row is
  `archived`. The runtime agent's row and the other human's row stay `active` (or remain lazily absent), and all
  `chat_membership` rows are unchanged.
- In user A's Workspace sessions, the archived row leaves the default Active view. A second device receives a bare
  `me-chats:changed` invalidation and refetches promptly rather than waiting for the polling floor. User B receives no
  private invalidation and sees no list change. The agent-scoped `chat list` may continue returning the archived chat
  because it is a structural membership inventory, not the human's engagement view.
- Confirm the generated agent briefing explains the safe current-chat order. In a live agent turn, send the required
  final human confirmation first and run `chat archive` as the final business action; the chat remains archived. In a
  separate disposable chat, deliberately send a message after archiving and confirm normal new-activity projection
  returns the acting human's view to Active.
- If the runtime-session enforcement mode is part of the target deployment, repeat one success with a valid current
  token and one request with a missing or invalid token. The invalid request must fail before the archive write.

## Expected result

`PASS` requires real evidence that participant-scoped authorization, signed-in-human attribution, idempotence,
current-chat fallback, private realtime sync, cross-user isolation, unchanged membership, and message-driven revival
all hold together.

`FAIL` means a reproducible target defect lets a nonparticipant archive, writes the runtime agent or another user's
engagement, changes membership, emits a private invalidation to another user, leaves the acting user's Active view
stale beyond the realtime/polling contract, or lets a post-archive message remain archived.

`BLOCKED` means the isolated candidate CLI/runtime/server/web cell, valid agent credentials, multiple-user fixtures,
or observable admin WebSocket sessions cannot be prepared. `INCONCLUSIVE` means only API/database evidence exists
without a real CLI invocation and Workspace observation, or the request/session attribution is ambiguous.

## Evidence

Keep target refs and build identifiers; redacted `chat list` and `chat archive` stdout/stderr with exit codes;
sanitized HTTP traces for `POST /api/v1/agent/chats/:chatId/archive`; before/after engagement and membership rows;
same-user and cross-user WebSocket frame summaries; Workspace screenshots or recordings of Active-view removal; and
message/revival timestamps. Store all artifacts outside the source repository.
