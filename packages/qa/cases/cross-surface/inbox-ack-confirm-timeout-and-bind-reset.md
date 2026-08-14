---
id: inbox-ack-confirm-timeout-and-bind-reset
description: Verify a confirmed inbox ACK stays at one same-socket retry then one 1011 close, and reconnect outcomes split on whether the ACK request already committed.
areas: [cross-surface]
surfaces: [server, client]
---

# Inbox ACK Confirm Timeout And Bind Reset

## Goal

Confirm the rare ACK-confirm failure path stays bounded: for a confirmed `inbox:ack` with `ref`, the Client sends only the initial frame plus one same-socket retry, then closes that socket once with `1011` / `inbox ack timeout`. There is no third send on that socket.

Reconnect recovery then depends on whether the Server already committed the ACK request. Dropping only the `inbox:ack:accepted` / `inbox:ack:rejected` confirm is not the same as the request never landing. Deterministic unit tests already cover the timer, cap, and in-flight snapshot rules; this case is the cross-process loop those tests cannot see.

## Preconditions

- Isolated run cell with Server and a built Client daemon on the same network.
- An authenticated daemon, one bound agent, and a chat that can deliver a notify-worthy inbox row to that agent.
- A way to intercept the ACK path without changing schema, wire fields, or persistence. Support both of these independently:
  - drop or withhold only `inbox:ack:accepted` / `inbox:ack:rejected` after the Server has accepted and committed the request;
  - drop the `inbox:ack` request itself, or suppress handling before the Server transaction, so the row is never settled.

## Operate

Shared Client bounds for both branches:

- Deliver one notify-worthy message to the bound agent and let the Client send a confirmed `inbox:ack` with a `ref`.
- Watch the same socket: the Client should send exactly one retry with the same `ref`, then close once with `1011` / `inbox ack timeout`. No third `inbox:ack` on that socket.
- Allow reconnect and `agent:bind` to finish. Do not manually ACK leftover rows unless a later current-socket delivery needs an ACK.

Then run the two branches as separate observations of the same Client bounds:

1. **Confirm dropped, request already committed.** Let the Server accept `inbox:ack` and persist the row as `acked`. Drop only the matching confirm frames.
2. **ACK request never committed.** Drop the request, or suppress handling before the transaction, so the row stays unsettled (`pending` / `delivered` / reset-pending). After fail-close, let bind reset recover it.

## Observe

Shared:

- Client logs or WS frames: two `inbox:ack` sends for that entry, no third send, one socket close, then a new connection and bind.

Branch 1 — confirm lost after commit:

- The notify row stays `acked` after reconnect.
- Bind reset does not redeliver that row and does not start a second provider turn for work that already entered the first turn.
- After `inbox:recover` reports `unackedOutstanding === 0` (or an equivalent server settlement proof), the Client must release that row from local unsettled work instead of waiting forever for a redelivery that cannot happen.

Branch 2 — request never committed:

- The notify row is still unsettled before reconnect.
- After fail-close, bind reset redelivers it to the new socket. The agent does not silently skip the message.
- A later ACK on the new socket commits only rows that socket actually delivered. Leftover prefix from another socket's delivery set is rejected.

## Expected Result

`PASS`: both branches keep initial + one retry, one `1011` close, and no third same-socket ACK. Branch 1 leaves the row `acked` with no redelivery, no second provider entry, and the Client ledger released after settlement proof. Branch 2 redelivers the unsettled row after bind reset, and a later ACK settles only the current-socket delivery set.

`FAIL`: unbounded 3s retries; a third ACK on the same socket; old ACKs replayed after rebind; treating a committed ACK as if it must redeliver; keeping the committed row as Client recovery debt after `unackedOutstanding === 0`; or an ACK that settles a row the current socket never delivered.

`BLOCKED`: the run cell cannot authenticate, bind an agent, or independently intercept confirm-drop versus uncommitted-ACK.

`INCONCLUSIVE`: delivery or reconnect happened, but confirm-drop versus uncommitted-ACK outcomes cannot be attributed to the target ref.
