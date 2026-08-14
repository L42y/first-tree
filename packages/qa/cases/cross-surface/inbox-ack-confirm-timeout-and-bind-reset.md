---
id: inbox-ack-confirm-timeout-and-bind-reset
description: Verify a dropped inbox ACK confirm causes one Client retry then one reconnect, and bind reset redelivers without losing or double-entering the message.
areas: [cross-surface]
surfaces: [server, client]
---

# Inbox ACK Confirm Timeout And Bind Reset

## Goal

Confirm the rare ACK-confirm failure path stays bounded and recoverable: when the Server accepts `inbox:ack` frames with `ref` but the Client never sees `inbox:ack:accepted`, the Client retries once on the same socket, then closes that socket. After reconnect and `agent:bind`, unacked work comes back through bind reset rather than disappearing or being ACKed from another socket's leftover prefix.

This is live Server + Client behavior around dropped confirm frames. Deterministic unit tests already cover the timer, cap, and in-flight snapshot rules; this case is the cross-process loop those tests cannot see.

## Preconditions

- Isolated run cell with Server and a built Client daemon on the same network.
- An authenticated daemon, one bound agent, and a chat that can deliver a notify-worthy inbox row to that agent.
- A way to drop or withhold `inbox:ack:accepted` / `inbox:ack:rejected` on the Client for one turn (proxy, debug hook, or Server-side confirm suppression). Do not change schema, wire fields, or persistence.

## Operate

- Deliver one notify-worthy message to the bound agent and let the Client send a confirmed `inbox:ack` with a `ref`.
- Drop the matching confirm frame.
- Watch the same socket: the Client should send exactly one retry with the same `ref`, then close with `1011` / `inbox ack timeout`.
- Allow reconnect and `agent:bind` to finish. Do not manually ACK leftover rows.

## Observe

- Client logs or WS frames: two `inbox:ack` sends for that entry, no third send, one socket close, then a new connection and bind.
- After bind reset, the unacked notify row is pending/redelivered to the new socket. The agent does not silently skip the message, and the provider does not start a second user-visible turn for work that already entered the first turn.
- A later ACK on the new socket commits only rows that socket actually delivered.

## Expected Result

`PASS`: one retry, one reconnect, bind reset redelivers the unacked row, and no message is lost or double-entered.

`FAIL`: unbounded 3s retries, a third ACK on the same socket, old ACKs replayed after rebind, or an ACK that settles a row the current socket never delivered.

`BLOCKED`: the run cell cannot authenticate, bind an agent, or intercept ACK confirm frames.

`INCONCLUSIVE`: delivery or reconnect happened, but confirm-drop and bind-reset outcomes cannot be attributed to the target ref.
