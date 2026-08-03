---
id: external-context-current-session-handoff
description: Validate same-session Team Context adoption through verified handoffs across Claude Code and Codex.
areas: [cross-surface]
surfaces: [web, server, cli, claude-code, codex, context-tree]
---

# External Context Current-Session Handoff

## Goal

Confirm that a member can paste the First Tree Web setup prompt into an
already-running Claude Code or Codex conversation and use Team Context in that
same conversation. Prove that the handoff comes only from a successful CLI JSON
envelope and the provider-installed, payload-verified Plugin; do not treat
Plugin UI discovery as proof of current-session adoption.

## Preconditions

- Use the formal isolated QA run cell with disposable Claude Code and Codex
  provider homes, a staging member, and a disposable Team whose Context Tree
  has a uniquely identifiable normal-content decision.
- Use one attached non-Git parent containing two disposable source repositories
  and one pathless fixture. Keep credentials and raw setup prompts outside
  committed artifacts and redact login codes, Team ids, and private Tree data.
- Begin Claude Code and Codex attached sessions with no First Tree Plugin.
  Also prepare Codex already-trusted and pathless variants.

## Operate

1. Copy the provider-neutral setup prompt from Web and paste it into the
   already-running Claude Code conversation. Let the agent run bootstrap and
   the server-authored JSON enable command with its host-confirmed selector.
2. Without restarting or running `/reload-plugins`, ask a task that triggers
   `first-tree-read`. Confirm the same agent reads the exact `skillPath`,
   uses the handoff's immutable provider/project receipt for the first Read,
   activates an exact Context Tree snapshot, and uses the unique Team decision.
3. Paste a fresh prompt into the already-running Codex attached conversation.
   Capture the first enable result, run `/hooks`, Enable + Trust First Tree
   Context, return to the original conversation, and reply `continue`.
4. Confirm that same Codex agent re-runs the exact enable command, consumes the
   handoff, then completes the same Context read task without exit or a new
   conversation.
5. Repeat Codex with an already-trusted Hook and with a pathless project; both
   must consume a complete handoff on the first enable.
6. After both a path-project and pathless handoff, change shell cwd to a
   different bound project (and then to an unbound directory) before the first
   Read. Confirm the path receipt still supplies its original `--project-root`
   and the pathless receipt still supplies `--pathless`; neither may invoke the
   current-cwd classifier or switch Team.
7. Run a direct human-mode `context enable` and retain its output. Confirm a
   Complete verdict includes the full usable handoff JSON with provider,
   project, activation context, and all three Skill catalog entries.
8. Tamper one installed Skill manifest, remove one Skill, make one manifest a
   symbolic link, and separately make live authority unavailable. Re-run enable
   for each state, restoring the fixture between attempts.
9. Start one later attached session for each provider and confirm the existing
   SessionStart path still activates automatically.

## Observe

- The Server command places global `--json` before `context enable`, includes
  the exact provider and Team, and includes `--yes`; Web adds no flags.
- Claude Code completes setup in one agent turn. Codex without consent returns
  `setup.complete: false` and `currentSessionHandoff: null`, asks only for
  `/hooks` consent plus return to the original conversation, and re-runs enable
  after `continue`.
- Every complete result has `currentSessionHandoff.schemaVersion: 1`, the exact
  top-level `activationContext`, the resolved provider/project receipt, and
  exactly `first-tree`, `first-tree-read`, and `first-tree-write` in stable
  order. Each description comes from strict frontmatter and each absolute
  `skillPath` is a readable regular file inside the provider-installed cache.
- The current agent adopts `activationContext` verbatim, treats the three
  entries as progressive-disclosure catalog entries, and reads the complete
  selected `SKILL.md` only when triggered.
- The agent preserves the handoff's verified `{ provider, project }` as an
  immutable current-session activation receipt. The first Read uses its exact
  path root or pathless selector even after cwd changes, and the returned
  `activationProject` receipt governs all later Read/Write routes.
- Human-mode Complete output includes the same usable receipt and Skill catalog
  rather than claiming a handoff is ready while printing only Team Context.
- Tampered, missing, linked, unreadable, stale-payload, binding, activation, or
  authority failures never produce a handoff or Complete verdict. First Tree
  never writes Hook trust, uses a bypass flag, or replays SessionStart.
- Later sessions still activate through provider Plugin + SessionStart; the
  one-shot handoff is not persisted as a second binding or workflow source.

## Expected Result

`PASS`: both providers use Team Context in the installation conversation with
the exact verified handoff contract, Codex consent remains provider-owned, all
failure states fail closed, and later SessionStart activation remains intact.

`FAIL`: either provider needs a restart/new conversation for functional Team
Context, Codex bypasses consent, Complete coexists with a null/invalid handoff,
an unverified Skill path is adopted, or future SessionStart behavior regresses.

`BLOCKED`: a disposable provider bridge, staging identity/Team, Context Tree,
or Web setup prompt cannot be prepared without reusing operator state.

`INCONCLUSIVE`: only unit tests or mocked surfaces were observed, the Context
read did not use the same provider conversation, or provider/auth evidence is
missing.

## Evidence

Keep redacted Web prompt/server handoff responses, both enable JSON envelopes,
provider conversation/session identifiers, `/hooks` screenshots and
`hooks/list` rows, absolute Skill paths plus payload digest evidence, exact Tree
read receipts, and later SessionStart output. Record CLI/provider versions,
project classification, commands, timestamps, and all fixture restoration.
