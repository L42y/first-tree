---
id: chat-session-reset
description: Validate that a manager can reset a managed agent's stopped chat session from the Participants hovercard, with success gated on the client's terminate apply-ack, and that the next addressed message starts a genuinely fresh session.
areas: [cross-surface]
surfaces: [web, server, client]
---

# Chat session reset

## Goal

Confirm the Workspace Participants recovery action clears one agent's
**stopped** session in one chat through the real Web → Server → Client path:
`Reset` lives only inside the agent's hovercard, only for suspended or failed
sessions on an online client with terminate apply-ack support, and a
success is shown only after the client has confirmed it dropped the local
provider-session mapping. The next explicitly addressed message must start a
new provider session while chat history stays intact.

The deterministic product tests own the visibility matrix, the ack/timeout/
disconnect/conflict contracts, the atomic evict+clear, and the late-event
fence. This case owns the live multi-surface behavior they cannot prove:
real command round-trips, real provider-session turnover, and the
disconnect-during-reset recovery journey.

## Preconditions

- Run the candidate Server, Web, and Client in an isolated QA cell with a real
  PostgreSQL database and WebSocket connections.
- Sign in as the manager of a non-human agent and open a chat where that agent
  is a speaker with a live session (at least one completed turn).
- Keep browser network, WebSocket frames, and a short screen recording
  available.

## Operate and observe

- While the agent is active — working or idle — open its hovercard and
  confirm there is NO `Reset` action. An idle active row must still offer
  `Pause`; use it, then reopen the card: a single `Reset` action appears for
  the suspended session.
- Choose Reset and confirm. Observe the pending state, then the success toast;
  the live activity/trace surface for that chat session clears and chat
  messages remain. The interrupted run does not resume by itself; a queued
  follow-up message may still be delivered to the fresh session.
- Send a new explicitly addressed message. Confirm a fresh session starts —
  a new provider session with no inherited private context — and the status
  returns to working/ready through the normal path.
- Repeat against a failed (session-errored) session; it resets directly and
  recovers on the next addressed message.
- Disconnect the client mid-reset (after the command frame is sent, before
  the agent applies it). Reset must fail honestly, the session must stay
  suspended/errored, and the entry must still be there after a page reload.
  Reconnect and retry: the client applies, acks, and Reset succeeds.
- With an old client build that lacks the apply-ack capability, confirm Reset
  never appears even for stopped sessions. With a second, unmanaged account
  (or a second agent in the same chat), confirm Reset is absent and the other
  agent's session is untouched.

## Evidence

Keep the hovercard/dialog/recovery recording, the ref'd `session:terminate`
command and matching `session:command:applied` frames, the terminate API
responses (including the failure cases), and before/after proof that the
provider session identity changed while the chat message history did not.

## Expected result

`PASS` when suspended and failed sessions reset through the card action with
apply-ack proof, active sessions never offer Reset, traces clear without
deleting chat history, a fresh provider session starts on the next addressed
message, a disconnect during the wait fails honestly and stays retryable
across reload/reconnect, and old clients or unmanaged viewers never see the
action.

`FAIL` when Reset appears for an active session or an incapable client, when
success is shown without the client apply-ack, when a reset deletes chat
history, or when the old session's private context survives into the next
turn.

`BLOCKED` when the isolated cell cannot run a real managed agent turn.

`INCONCLUSIVE` when the recording or frame evidence cannot attribute the
session change to the Reset action on the candidate build.
