---
id: agent-runtime-session-token-delivery
description: Verify runtime-session tokens rotate through the per-agent file, stale proof triggers bind-gated recovery, and stale env snapshots are never reused.
areas: [cross-surface]
surfaces: [server, client, cli]
---

# Agent Runtime Session Token Delivery

## Goal

Verify the real product loop where each `agent:bind` mints a fresh runtime-session token, persists it to the per-agent
token file, and makes every agent-scoped HTTP call read the current file value. The case also checks that stale
`FIRST_TREE_RUNTIME_SESSION_TOKEN` environment snapshots cannot override the file and cannot act as a fallback. When
the file is missing or stale during Inbox work, the runtime must retain custody and recover through one fresh agent bind
instead of presenting a provider-login error or repeatedly resetting the same Inbox entry on the stale socket.

## Preconditions

- Use an isolated run cell with candidate server, candidate CLI/daemon, task-local `FIRST_TREE_HOME`, and real WebSocket
  registration.
- Do not use operator staging/prod homes or credential stores.
- Redact token plaintext. Record only token file path, size, mtime, sha256, and whether the server DB hash changed.

## Operate

- Start a candidate server with runtime-session enforcement disabled, then bootstrap a candidate CLI/daemon with a
  task-local home and bind one test agent.
- Observe the first bind minting a token and writing the per-agent token file.
- Run an agent-scoped CLI command with a bogus `FIRST_TREE_RUNTIME_SESSION_TOKEN` env value and a valid
  `FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE`.
- Rotate the token through a reconnect/rebind and run a second agent-scoped CLI command without restarting the agent
  subprocess.
- Repeat the command after deleting the token file and after replacing it with an empty file.
- Repeat the relevant HTTP checks with runtime-session enforcement enabled.
- While enforcement is enabled, deliver Inbox work and remove or stale the token file before the agent-scoped HTTP step.
  Keep the WebSocket connected and observe the failure, automatic rebind, token-file replacement, and redelivery.
- Inject two chats into the same stale-proof window to confirm they coalesce onto one agent rebind. Also force that bind
  to fail once and verify the Inbox rows remain unacked without a same-socket recovery storm.

## Observe

- Each successful bind writes a non-empty per-agent token file and updates server runtime-session metadata.
- Agent-scoped HTTP after a rebind uses the new file token without requiring the long-lived agent subprocess to restart.
- A bogus `FIRST_TREE_RUNTIME_SESSION_TOKEN` env value does not override a valid token file for CLI calls.
- Missing or empty token files put the CLI in token-less mode rather than falling back to the stale env value; with
  enforcement disabled those requests are accepted with a legacy warning, and with enforcement enabled they fail as
  missing-token requests.
- With enforcement enabled, a stale non-matching runtime-session token is rejected as invalid, while a missing file is
  rejected as missing, using distinct stable response codes.
- Missing/invalid proof is reported as a runtime connection fault, never as provider credentials; no provider Connect
  action is offered.
- The failed Inbox entry is not ACKed and no runtime failure notice is attempted through the same broken HTTP proof.
  The affected chat remains held until a successful `agent:bound`; that bind replaces the token and redelivers the debt.
- Concurrent proof faults for one agent produce one rebind. A failed rebind retains debt, and repeated identical
  same-socket recovery requests eventually open the server no-progress fuse instead of redelivering forever.

## Expected Result

`PASS` when real daemon/CLI/server evidence shows per-bind token rotation, atomic token-file persistence, fresh file reads
for each agent-scoped HTTP request, no env-token fallback, and the expected enforcement=false/true outcomes. The
stale-proof branch must additionally show one bind-gated recovery with preserved Inbox custody and no provider-login
misclassification or same-socket hot loop.

`FAIL` when agent-scoped HTTP uses a stale env snapshot, fails after token rotation despite the file containing the current
token, falls back to env after a missing/empty file, or does not distinguish invalid-token and missing-token failures under
hard enforcement. It also fails when stale proof ACKs or drops the Inbox entry, posts through the broken HTTP path,
offers provider login, creates more than one concurrent rebind, or repeatedly redelivers without a progress boundary.

`BLOCKED` when setup, auth, provider, DB, or isolated-home preconditions prevent validation.

`INCONCLUSIVE` when evidence is partial, unstable, or not attributable to the candidate refs.
