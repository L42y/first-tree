---
id: grok-provider
description: Validate the Grok Build CLI runtime provider end to end — external binary, ACP sessions, managed MCP, real turns, free-form model and reasoning effort, and Context Tree I/O evidence.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Grok Build Runtime Provider

## Goal

Confirm that an agent bound to the `grok` provider runs real turns through the external Grok Build CLI over ACP with
the canonical runtime posture, that credential and capacity failures surface through the existing recovery paths, and
that cross-surface behavior (capability cards, managed MCP, model and reasoning-effort inputs, client switch, Context
Tree I/O) matches the shipped contract. Deterministic parser/handler behavior is covered by product tests; this case
validates the live judgment slices those tests cannot prove.

Use this case when the grok handler, capability probe, runtime-auth dispatch, or provider selection surfaces change.
Pair it with the runtime-provider readiness case when the same run must also prove that existing Claude Code / Codex
agents on the client keep probing, binding, and completing turns — that cross-provider regression question belongs to
that case and the run-local plan, not this one.

## Preconditions

- Run in the isolated QA run cell selected by the plan (Docker + temporary git worktree; never the operator checkout).
- The run cell host has the official external Grok Build CLI installed (`grok`, via
  `curl -fsSL https://x.ai/cli/install.sh | bash`); First Tree must not bundle, download, or install it for you — if it
  is absent, exercise only the install-hint branch and mark live branches `BLOCKED`. V1 supports macOS/Linux only.
- A Grok account the run may authenticate on that host. Login state is host-OS-user-scoped and operator-owned; do not
  copy credential files between users or machines, and do not drive `grok login` outside the operator-approved flow.
- Do not modify the tested product object; config and fixtures change only inside the run cell.

## Checklist

- Capability: with the CLI absent, the computer card shows setup-incomplete for Grok Build with the official installer
  command (`curl -fsSL https://x.ai/cli/install.sh | bash`) and no npm install copy; after installing and re-probing,
  the entry turns `ok` with a `path` runtime source. Detection must never launch the binary or judge login state.
- Provider selection: a new agent can be created on `grok` only when the bound client advertises it; afterwards the
  provider changes only via the explicit runtime-switch flow, matching the other providers.
- Auth recovery: with the CLI logged out, a real turn fails as a credential failure; the chat surfaces a durable
  runtime notice plus a "Log in to Grok Build" action before the delivery is acked. Driving the login runs the
  provider's official login on the host (`grok login`); progress rides `pendingAuth` / `lastAuthError` on the
  capability entry, and after success a fresh turn completes. First Tree must never see or store the token.
- Real turn posture: during an authenticated turn, verify the spawned process runs from the agent workspace root with
  the canonical arguments (`grok --no-auto-update agent --no-leader --always-approve stdio`, plus `--model` only when
  the operator set one and `--effort` only when a non-inherit effort is set) — the prompt must arrive on stdin only,
  never in argv. The process is short-lived per turn; no daemon or lingering process survives turn completion.
- ACP session continuity: a follow-up message in the same chat must resume the same Grok session — the session ID is
  persisted per chat and the next turn's process resumes it via ACP `session/load`; a fresh chat starts with
  `session/new`. A restarted daemon must still resume the persisted session id.
- Parallel isolation: two chats bound to agents in the SAME workspace cwd run in parallel without cross-talk — each
  turn gets an isolated Grok session directory, and neither turn observes the other's session state or file locks.
- Managed MCP: configure a disposable local MCP server through First Tree, then verify the client passes it to the
  Grok turn through the ACP `mcpServers` session payload (no provider-side config file mutation), and the
  authenticated Grok turn calls one of its tools. Removing the managed server must drop it from the next turn's
  `mcpServers` payload with no residue. Do not inspect or archive literal secret headers.
- Managed skills: with managed skills configured, verify the reconciler projects them into
  `<agent workspace>/.grok/skills/` and a turn can invoke one.
- Free-form model: set an exact model id through Web (free-form input with the `auto (Grok default)` hint), confirm it
  round-trips and reaches the next turn's spawn as `--model`; an id the provider rejects must fail visibly as a
  configuration failure with no silent fallback, and recover after an explicit config change.
- Model/effort on an EXISTING session: with a chat that already has a persisted Grok session, change the model and/or
  effort in Web and send the next message — the resumed turn must apply the new selection via ACP `session/set_model`
  after `session/load` and before the prompt (session/load restores the session's persisted model/effort, so argv-only
  selection would silently keep the old values). An invalid model must be visibly rejected by `session/set_model` as a
  configuration failure — never a silent fallback to the persisted selection.
- Reasoning effort: the effort control is shown for Grok Build with inherit/low/medium/high. Round-trip each value:
  low/medium/high reach the next turn's spawn as `--effort <value>` and are re-applied AND confirmed after every
  session open via `session/set_model` (`_meta.reasoningEffort`). An explicit model is always re-applied with it;
  clearing only the effort removes just the effort override (no effort meta is sent) while the explicit model is
  still re-applied — only when the model is ALSO empty does the next turn's `session/set_model` carry the
  initialize-advertised default model, resetting the session to the provider default. An existing session's
  persisted selection is never silently kept. Confirmation: a configured effort runs the prompt ONLY when the
  provider's `model_changed` echo carries the effective model+effort — a missing echo, an omitted effort field, or
  a different effort value fails as a configuration failure and the turn does not run (a model without
  reasoning-effort support silently ignores the override upstream while still returning a successful model
  response, so the response alone cannot prove the effort was applied).
- Replay contract on resume: a resumed turn sends `session/load` with `_meta.noReplay: true`, and any historical
  notification stamped `_meta.isReplay` is dropped even when it arrives inside the active prompt window — the resumed
  turn's visible output and `token_usage` must reflect only the current prompt.
- Terminal stop reasons: a turn ending with an ACP completion stop reason other than `end_turn` (`max_tokens` or
  `refusal`) still completes the turn with the accumulated assistant text and usage preserved — it must not surface
  as a provider failure. A provider-side `cancelled` is an abnormal end routed through ProviderAttempt/replay-safety
  like any other failure: redelivery only when the turn is replay-safe, consumed-terminal when user-visible output
  or tool side effects already happened — never an unconditional abort/redelivery.
- Discovery version gate: host-local model discovery resolves the binary through the launch-verified supported range
  (`>=0.2.117 <0.3.0`), never the existence-only probe path; an out-of-range `grok` degrades the catalog to
  `unavailable` instead of spawning the ACP handshake.
- Context Tree I/O: in a chat whose agent has a bound Context Tree, have the agent read a tree node and edit a tree
  file; the Context tab must record repo-qualified read/write evidence for the native Grok file tools
  (`read_file`, `write`, `search_replace`) and for the shell-read path (`git_status_delta` may carry the write).
- Capacity retry: on a free-tier account, drive turns until Grok answers 429 capacity; the retry must be visible as a
  transient retry (not a terminal failure), ride the provider-turn retry budget, and the turn must complete once
  capacity returns — or fail with the standard terminal provider event and durable runtime notice after exhaustion.
- Client switch: with a Grok turn in flight, a local client switch/logout drain must detect the running `grok`
  process (First Tree env envelope scoped) and fail closed rather than moving root state.

## Expected Result

`PASS` means the live branches above were exercised with real product evidence: an authenticated Grok turn completed
end to end under the canonical posture, credential failure surfaced the durable notice + login action and recovered
in-product, ACP session new/load continuity held across turns and a daemon restart, model/effort changes on an
existing session were applied via `session/set_model` after `session/load` (invalid model visibly rejected, no silent
fallback), replay-marked traffic on resume was filtered, terminal stop reasons completed with preserved text,
discovery stayed behind the version gate, same-cwd parallel chats stayed isolated, a First Tree-managed MCP tool was
delivered via `mcpServers` and called, model and effort config round-tripped, 429 capacity produced a visible retry,
and Context Tree I/O evidence appeared for both native-tool and shell-read paths.

`FAIL` means a reproducible product issue: e.g. prompt in argv, a session id resumed in the wrong chat, a resumed turn
silently keeping the session's persisted model/effort instead of the configured one, replayed history leaking into a
resumed turn's output or usage, a terminal stop reason surfaced as a provider failure, model discovery spawning an
out-of-range binary, a lingering process after turn completion, a terminal failure acked without a durable chat
notice, silent model or effort fallback, managed MCP leaking into provider-side config files or surviving removal,
cross-chat session-dir interleaving, a 429 surfaced as terminal without retry, missing Context Tree I/O evidence, or a
drain that misses a live `grok` process.

`BLOCKED` means the CLI, account, entitlement, network, platform (Windows), or run-cell topology prevented a live
branch — never a product `FAIL`. `INCONCLUSIVE` means turns ran but the evidence cannot distinguish the claimed
behavior (e.g. cannot observe the spawned argv or the ACP wire payloads in the run cell).

## Evidence

Keep the capability snapshots (before/after install and login), the spawned process argv/cwd observation, the failing
turn's runtime notice and the login action, the ACP session new/load ids across two turns and across a daemon
restart, the parallel same-cwd isolation observation, sanitized `mcpServers` session payloads (add and remove), the
`.grok/skills` projection listing, the model and effort config writes/readbacks plus the rejection surface, the 429
retry sequence, the Context tab I/O rows, and the drain classification result. Keep the ACP wire logs; redact tokens,
headers, account identifiers, and private chat content; never copy Grok credential files into artifacts.
