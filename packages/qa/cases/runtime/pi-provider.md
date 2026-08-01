---
id: pi-provider
description: Validate the external Pi CLI RPC provider end to end — long-lived RPC session, steer/abort settlement, auth, skills, and process drain.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Pi Runtime Provider

## Goal

Confirm that an agent bound to `pi` runs through the official external `pi --mode rpc`
JSONL protocol, reuses provider-owned host-local authentication without giving First Tree
token custody, and preserves First Tree's delivery, session, configuration, Context Tree I/O,
and process-drain contracts.

Use this case when the Pi handler, RPC client, binary resolver, capability probe, model
surface, skills projection, or provider supervisor changes.

## Preconditions

- Run in the isolated QA cell selected by the plan: Docker plus a temporary source worktree, with an explicit native
  bridge only where the OS process authority cannot live inside Docker. Never modify the operator checkout.
- Install a Pi version in the product's supported `>=0.80.4 <1.0.0` range on the client host and complete provider-owned
  setup by running `pi` then `/login`. The test may prove the login by completing a real turn, but must not read, copy,
  print, or archive provider credential files.
- Use disposable source and Context Tree fixtures. Provider tool calls must not modify the product checkout.
- Windows acceptance requires the separately owner-reviewed drain-authority decision and a product Job Object
  supervisor. Until both exist, the Windows branch must fail closed before any Pi invocation and cannot PASS.
- V1 has no native MCP: keep the agent `mcpServers` empty. A non-empty set is a deterministic configuration failure.

## Checklist

- Capability: the connected client reports `pi` as `missing` or `ok` solely from the same binary resolver used by the
  handler. Re-probing must not launch Pi, inspect auth/config, list models, or contact a model provider. Windows stays
  unavailable.
- Provider selection: Web and CLI expose Pi only on a client advertising the capability. The config defaults to an empty
  model, accepts an exact provider-native `provider/model` string, and exposes no separate reasoning-effort control.
- Runtime gates: the first active use launches `pi --version` through the provider supervisor and requires a stable
  release in `>=0.80.4 <1.0.0`; older, `>=1.0.0`, prerelease, and unparseable output fail closed. Transient launch
  timeouts remain retryable.
- Spawn contract: observe one long-lived
  `pi --mode rpc --offline --no-extensions --no-skills --skill <cwd>/.agents/skills --no-prompt-templates --no-approve
  --session-id <stable-id> --session-dir <cwd>/.first-tree-workspace/pi-sessions` process per active `(agent, chat)`,
  plus `--model` only when configured. Prompt text rides JSONL stdin, never argv.
- Child boundary: observe the First Tree identity/drain envelope and runtime-session token-file path in the child
  environment. Token contents and provider credentials must not enter argv, logs, Server data, or retained evidence.
- Real turn: verify normalized assistant, thinking, tool, token-usage, and successful terminal events. Turn completion
  is only `agent_settled` — never treat `agent_end` as delivery settlement. Prove a disposable `read`/`write`/`edit`
  tool effect with stable `toolCallId` correlation.
- Session and inject: the session id is deterministic for the agent/chat pair and survives suspend/resume plus process
  restart against the same `--session-dir`. Inject during streaming uses `steer`; non-streaming input starts the next
  prompt. Only transfer delivery ownership after Pi accepts the command.
- Abort / suspend: abort mid-stream, wait for both the abort response and `agent_settled` in either order, then close
  stdin/process cleanly without orphaning the RPC child.
- Managed Skills: projected Skills live under `.agents/skills` (shared Codex native root). Confirm `--no-skills --skill
  ...` still discovers a disposable First Tree skill. Do not create `.pi/skills`.
- Auth and failure custody: a logged-out real turn produces a durable error notice directing the operator to run `pi`
  then `/login`; First Tree offers no in-product OAuth and never reads Pi credentials. A `success:false` preflight
  without `agent_settled` must not hang. Terminal failures are consumed only after the durable notice.
- MCP boundary: a non-empty effective `mcpServers` set fails as a visible configuration failure before a prompt is
  launched. An empty set proceeds normally.
- Context Tree I/O: Pi `read` records `pi_read_tool`; `write`/`edit` record `pi_write_tool`; qualifying `bash` commands
  produce the provider-neutral shell evidence with repo/path qualification.
- Process safety: on POSIX, prove the existing environment-attributed OS process-tree drain observes and clears the Pi
  root and descendants. On Windows, prove pre-admission Job Object authority before any invocation. Child registry
  evidence is diagnostic only and must never authorize a client switch.

## Expected Result

`PASS` requires a real authenticated two-turn First Tree/Pi RPC flow with session continuity, steer or queued inject
evidence, a deterministic tool effect, Skills evidence under `.agents/skills`, correct delivery and failure custody,
normalized events, Context Tree I/O, and platform-accepted process-drain proof.

`FAIL` includes prompt text in argv, credentials retained by First Tree, an unadmitted runtime process, silent model
fallback, treating `agent_end` as settlement, hanging on credential preflight, silent non-empty MCP acceptance, unsafe
side-effect replay, terminal failure consumed before its durable notice, or a client switch authorized by child
registry alone.

`BLOCKED` means a compatible CLI, provider login/entitlement/network, isolated platform bridge, owner-reviewed Windows
drain authority, or product Job supervisor is absent. Unit tests and a raw Pi CLI probe alone do not turn a blocked
First Tree product branch into PASS. `INCONCLUSIVE` means a live turn ran but retained evidence cannot distinguish the
claimed behavior.

## Evidence

Keep sanitized capability snapshots, exact binary/version and argv/cwd observations, session ID continuity across
suspend/resume, event-kind sequence including `agent_settled`, disposable file hashes, Context Tree rows,
delivery/retry/notice transitions, and authoritative drain receipts. Never retain provider request bodies, credential
files, runtime-session token contents, private prompts, or raw stderr before redaction.
