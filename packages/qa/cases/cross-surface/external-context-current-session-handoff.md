---
id: external-context-current-session-handoff
description: Validate thin-Plugin migration, exact-release Core loading, concise setup recovery, and current-session handoff across Claude Code and Codex.
areas: [cross-surface]
surfaces: [web, server, cli, claude-code, codex, context-tree]
---

# External Context Current-Session Handoff

## Goal

Confirm that an already-running Claude Code or Codex conversation can install
the thin First Tree Context Plugin, complete provider-owned consent, and load
the current CLI release's canonical Core workflow. Prove that a later Core-only
CLI upgrade needs no Plugin reinstall, Claude reload, or repeated Codex trust.

## Preconditions

- Use isolated disposable provider homes, a staging member, and a disposable
  Team with a uniquely identifiable Context Tree decision.
- Prepare both no-Plugin and legacy full-Plugin provider states. Keep an older
  same-channel CLI earlier on `PATH` while Web bootstrap installs the current
  portable exact-version release.
- Prepare attached, pathless, expired-login, transient-network, local Plugin
  drift, account-switch, and missing-permission fixtures. Redact credentials,
  receipts, internal paths, and private Tree content.

## Operate

1. Paste the Web bootstrap prompt into each already-running provider. Verify
   normal progress mentions only checking, installing/updating, required user
   action, and completion; it must not narrate commands or expose raw JSON,
   plan ids, digests, receipts, journals, Plugin cache paths, or Hook internals.
2. Inject one retryable timeout and one reversible local Plugin drift. Confirm
   the agent retries the exact transient action no more than twice, or runs only
   the CLI-provided exact repair/retry action, then rechecks the original step.
3. Exercise scope choice, account-switch consent, login/auth/permission,
   Claude `/reload-plugins`, Codex Hook trust, destructive reset, and a changed
   plan. Confirm the agent always stops for the user at these boundaries and
   never hand-edits provider cache, Context config, receipts, or journals.
4. Install or migrate Claude. Confirm apply returns `setup.complete: false`
   and no handoff until `/reload-plugins` is performed. Reply `continue`, verify
   the reloaded Plugin's `UserPromptSubmit` Hook returns one opaque
   current-session receipt, and rerun the original exact apply with that receipt.
   Confirm the general Skill loader creates no observation state. After the
   obligation is consumed, submit another prompt and confirm the Hook is a pure
   no-op with no provider probe, receipt, or additional Context injection.
5. Install Codex, complete `/hooks` trust in the same conversation, then rerun
   the same apply command. Repeat with an already trusted Hook.
6. Inspect the complete schema-v3 handoff. Trigger Read and Write separately;
   each task must run its loader command anew and read the returned exact
   release `policyPath` and `skillPath`. Change cwd before first Read and prove
   the immutable provider/project receipt still governs routing.
7. Upgrade to a CLI release whose Core Skill or Policy bytes differ while
   adapter bytes and `adapterVersion` are unchanged. In a new task, confirm the
   loader returns the new exact release paths and digest. Do not reinstall or
   reload the Plugin; Codex trust must remain trusted.
8. Invoke the legacy full Plugin's retired `context read` against the new CLI.
   Confirm typed `CONTEXT_PLUGIN_RELOAD_REQUIRED` and no Tree read. Tamper a
   Core file, symlink a Core path outside the exact release, and remove an old
   exact release; each must fail closed without a HOME Core cache fallback.
9. Upgrade only the thin adapter while keeping its loader protocol compatible.
   Confirm SessionStart returns one exact sync action within five seconds and
   does not install. The agent syncs in the normal turn while the old adapter
   continues the current task. Claude reload is optional for immediate adoption;
   without it, and for Codex, the new adapter is guaranteed next session. Inject
   one provider-install failure, verify rollback and quiet `update_deferred`, and
   confirm current First Tree work continues.
10. If bounded safe recovery still fails, confirm the agent reports only the
   blocker, attempted recovery, and one concrete next step; raw diagnostics are
   attached only when needed for targeted troubleshooting or a bug report.

## Observe

- Persistent handoff schema is 3 and contains stable descriptions plus loader
  commands, not reusable Plugin-cache Core paths. Loader response schema is 1,
  `consumerKind` is `byo`, and paths remain inside one verified exact CLI
  release root with matching Skill and Policy digests.
- Provider Plugins contain only discovery stubs, SessionStart adapter, and
  loader calls. They contain no full Read/Write workflow or Policy copy.
- Legacy full→thin migration and repair without a known-good adapter require Claude reload;
  successful observation gates `setup.complete`. Core-only upgrades and new
  Team grants leave adapter bytes/version/digest and install plan unchanged.
- A routine compatible adapter update is not setup failure: current tasks keep
  their verified loaded adapter, sync runs outside SessionStart, and reload/trust
  is requested only for immediate adoption or a provider-reported Hook identity change.
- Session-only loads verified Core without installing Plugin, Hook, grant, or
  observation state and does not promise future-session activation.
- The current conversation adopts `activationContext`, loader catalog, scope,
  and immutable provider/project receipt. It never reclassifies from changed
  cwd or reuses a Core path for another task.
- Human confirmation boundaries remain unchanged under recovery. No recovery
  path chooses scope, changes account, authenticates, grants permission,
  reloads/trusts a provider, resets state, or accepts a changed plan.

## Expected Result

`PASS`: both providers complete in the original conversation; first migration
uses the required provider lifecycle; later Core-only releases load on the next
task with stable adapter identity; recovery is bounded, concise, and preserves
every human boundary; all tamper and legacy paths fail closed.

`FAIL`: a legacy workflow reads Tree data, Claude completes before observation,
a Core-only release repairs/reloads/retrusts the Plugin, loader escapes or uses
a mutable path/HOME cache, setup leaks internal envelopes by default, or safe
recovery crosses a human boundary.

`BLOCKED`: disposable real providers, staging identity/Team, exact-version
release fixtures, or controlled failure injection cannot be prepared.

`INCONCLUSIVE`: only unit tests/mocks were observed, provider conversations are
not the same ones used for setup, or adapter/Core byte evidence is missing.

## Evidence

Keep redacted Web prompt and concise transcript, exact apply commands, typed
failure/recovery evidence, before/after adapter manifests and byte digests,
Claude reload observation, Codex trust rows, loader envelopes and exact release
paths, Tree read receipts, and tamper/legacy failure output. Record versions,
timestamps, task/session ids, and fixture restoration.
