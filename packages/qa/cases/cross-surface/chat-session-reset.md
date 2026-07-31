---
id: chat-session-reset
description: Validate that a manager can reset a managed agent's chat session from the Participants hovercard and that the next addressed message starts a genuinely fresh session.
areas: [cross-surface]
surfaces: [web, server, client]
---

# Chat session reset

## Goal

Confirm the Workspace Participants recovery action clears one agent's session
in one chat through the real Web → Server → Client path: the `Reset` action
lives only inside the agent's hovercard, the confirm dialog tells the truth
about scope, and after a successful reset the next explicitly addressed
message starts a new provider session while chat history stays intact.

The deterministic product tests own the visibility matrix, the suspend →
terminate sequencing, and the `errored → evicted` transition. This case owns
the live multi-surface behavior they cannot prove: real Client command
delivery, live-activity trace clearing, and fresh-session creation.

## Preconditions

- Run the candidate Server, Web, and Client in an isolated QA cell with a real
  PostgreSQL database and WebSocket connections.
- Sign in as the manager of a non-human agent and open a chat where that agent
  is a speaker with a live session (at least one completed turn).
- Keep browser network, WebSocket frames, and a short screen recording
  available.

## Operate and observe

- Open the Participants roster and confirm no row-level Reset affordance
  exists. Open the agent's hovercard and confirm a single `Reset` action.
- While the agent is mid-turn (working), choose Reset and confirm. Observe
  that the run stops, the success toast appears, and the live activity/trace
  surface for that chat session clears. Verify chat messages remain.
- Send a new explicitly addressed message. Confirm a fresh session starts —
  a new provider session with no inherited private context — and the status
  returns to working/ready through the normal path.
- Repeat the reset against a suspended session and against a failed
  (session-errored) session; both must reset directly and recover on the next
  addressed message.
- With a second, unmanaged account (or a second agent in the same chat),
  confirm Reset is absent and the other agent's session is untouched.
- Disconnect the agent's Client and confirm Reset is not offered while the
  agent is offline.

## Evidence

Keep the hovercard/dialog/recovery recording, the `session:suspend` and
`session:terminate` WebSocket frames (when applicable), the terminate API
responses, and before/after proof that the provider session identity changed
while the chat message history did not.

## Expected result

`PASS` when every resettable state (active, suspended, failed) resets through
the card action, traces clear without deleting chat history, a fresh session
starts on the next addressed message, and unauthorized/offline/no-session
states never offer the action.

`FAIL` when Reset appears outside the confirmed contract (row-level, human
cards, unmanaged viewers, offline agents), when a reset deletes chat history,
or when the old session's private context survives into the next turn.

`BLOCKED` when the isolated cell cannot run a real managed agent turn.

`INCONCLUSIVE` when the recording or frame evidence cannot attribute the
session change to the Reset action on the candidate build.
