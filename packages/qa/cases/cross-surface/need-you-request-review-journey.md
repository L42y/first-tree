---
id: need-you-request-review-journey
description: Validate that one human-targeted agent request blocks ordinary chat sends, survives cross-surface review navigation, supports durable clarification, and resolves exactly once.
areas: [cross-surface]
surfaces: [client, server, web]
---

# Need you request review journey

## Goal

Confirm the live request-review loop from an agent's `format="request"` message through the human's Chat and Need you
surfaces. An open request must exclusively own the answer path, remain durable while the human inspects context or asks
the agent for clarification, preserve the unfinished answer across surface navigation, and resolve exactly once through
an explicit Submit or Skip.

Deterministic product tests own keyboard semantics, disabled controls, schema compatibility, route authorization, and
draft restoration. This case owns the real boundaries those tests cannot prove alone: Client delivery and wake-up,
WebSocket/cache convergence, navigation between desktop and mobile review surfaces, attachment upload custody, and an
agent's clarification reply.

## Preconditions

- An isolated candidate cell with real PostgreSQL, Server, Web, and a connected Client/agent runtime. Keep the product
  source tree unchanged during execution.
- One human and one managed agent sharing a chat in Team A. For the tenancy branch, use another active member in Team A
  who is not in the chat and an authenticated member in Team B.
- A request with two options plus an attached image, followed by a second free-text request so FIFO advancement can be
  observed. Keep browser network, WebSocket, and a short screen recording available.

## Operate and observe

- Focus the ordinary chat composer, then have the agent deliver the first request. The request dialog must take focus
  and the composer must cease to be interactive. Press Enter and click where the old Send control was; neither may
  produce an ordinary message.
- Type an Other note, select an option, and attach both an image and a document. Open full chat, return with browser
  Back, and confirm all four draft parts remain staged without uploading or resolving early.
- Press Escape from Chat and from Need you. Escape may enter the documented non-resolving inspect/list state, but it
  must never send Skip, decrement the queue, or clear the request. Reopen review and confirm the same FIFO item remains.
- Use Ask agent. While the clarification POST is in flight and while waiting for the agent, try option changes, text
  edits, attachment add/remove, Submit, Skip, close, Escape, and keyboard submit. Every resolving/editing action must
  remain frozen. Let the real agent reply and confirm the durable clarification thread appears without resolving the
  original request; normal controls resume only after the wait ends.
- Submit the preserved answer. Confirm exactly one resolving reply carries the option/note/attachments, the first
  request leaves both Chat and Need you, and the second request becomes current. Exercise explicit Skip on that second
  item and confirm it resolves once.
- Repeat the essential block, Escape, Ask-agent wait, and Submit branches in the canonical mobile Chat surface. Direct
  `/m/chat` entry and PWA launch must preserve query/hash state.
- In Team A, the same-org nonparticipant must receive the anti-enumerating failure for request thread and Ask-agent
  routes. The Team B caller must not read Team A's queue, thread, or request. No request content, count, or existence
  hint may cross the boundary.

## Evidence

Keep the target SHAs and component versions; request, clarification, agent-reply, resolving-message, upload, and queue
item IDs; redacted network responses for queue/thread/Ask-agent/resolve; the relevant WebSocket/cache events; and a
screen recording showing focus takeover, frozen wait state, non-resolving Escape, draft restoration, and FIFO advance.
For mobile, retain the final pathname and a standalone-launch capture. Never retain tokens, cookies, private attachment
contents, or unredacted cross-tenant data.

## Expected result

`PASS` requires exclusive answer ownership, non-resolving Escape, a fully frozen Ask-agent wait, complete draft
restoration including attachments, one durable clarification thread, exactly-once FIFO resolution, canonical
`/m/chat`, and tenant isolation.

`FAIL` includes any background send, implicit Escape resolution, editable/resolving controls during the wait, lost
draft material, premature or duplicate resolution, queue drift, or cross-tenant disclosure.

`BLOCKED` applies when the isolated cell cannot start a real Server/Web/Client path, the agent runtime cannot produce a
clarification reply. `INCONCLUSIVE` applies when partial evidence cannot attribute a visible result to the candidate
build. Source inspection or mocked component events alone cannot upgrade this cross-surface journey to `PASS`.
