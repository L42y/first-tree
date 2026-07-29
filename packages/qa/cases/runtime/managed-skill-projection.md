---
id: managed-skill-projection
description: Validate that Core and Team Skills reconcile into each provider's native discovery root without overwriting user content or applying stale Cloud snapshots.
areas: [runtime]
surfaces: [web, server, client, cli]
---

# Managed Skill Projection

## Goal

Confirm through real provider-backed sessions that the Client settles managed
Core and Team Skills before the provider starts or resumes, uses only the
active provider's native discovery root, and preserves user-owned content
across config changes and provider switches.

Deterministic transaction phases, digest drift, schema parsing, unsafe names,
and crash recovery belong in product tests. This case owns the live boundaries
those tests cannot prove: Cloud Resource delivery, installed Client payloads,
provider-native discovery, real start/resume behavior, and operator-visible
degradation.

## Preconditions

- Use the isolated QA run cell and temporary worktree selected by the formal
  plan, never an operator workspace.
- Make at least one selected provider `one-turn-ready`. Cross-provider claims
  require each named provider to be independently ready.
- Use disposable Team Skills with non-sensitive bodies and a disposable
  user-authored Skill conflict. Do not inspect provider credentials or include
  private Skill content in evidence.
- Preserve the tested product checkout; all workspace and Cloud Resource
  changes must be run-local fixtures.

## Checklist

- Start one agent for each selected runtime and confirm Core Skills appear only
  under the native root: Claude `.claude/skills`, Codex `.agents/skills`,
  Cursor `.cursor/skills`, or Kimi `.kimi-code/skills`. A real turn must be
  able to discover and invoke a Core Skill without a cross-provider symlink.
- Bind a disposable Team Skill in Cloud, start or inject the next turn, and
  confirm the provider discovers its normalized effective name. The generated
  briefing should list the Team Skill description without exposing a
  filesystem path.
- Change the Team Skill body and confirm the next reconciled turn observes the
  new content. Remove the binding and confirm a later authoritative reconcile
  revokes it before the provider turn begins.
- Plant a user-owned Skill at the requested Team name. The managed Team Skill
  must receive a deterministic First Tree suffix while the original directory
  remains byte-for-byte unchanged. Plant a conflicting Core name with
  different content and confirm the Client reports degradation rather than
  overwriting it.
- Exercise a transient config-read failure after a good snapshot. The
  last-known-good Team directory must remain on disk, the Client must emit a
  bounded warning, and no empty fallback may revoke it. Once an authoritative
  newer snapshot returns, convergence resumes.
- If the environment can move one disposable agent workspace between provider
  runtimes, confirm the new provider projection is usable before recorded old
  targets disappear. Claude TUI and Claude SDK should share the Claude root
  without duplicating targets.
- Resume a pre-redesign Claude session from a disposable legacy per-chat cwd.
  Confirm Skills reconcile into that cwd's Claude root without running the
  broader agent-home source-repository/bootstrap flow.

## Expected Result

`PASS` requires real provider evidence that every selected runtime discovers
the reconciled Skill in its native root, Cloud update and revoke behavior
settles before the relevant turn, unavailable config preserves
last-known-good content, and user-owned conflicts are not overwritten.

`FAIL` includes a provider missing a settled Skill, a Team Skill appearing in
the wrong provider root, a stale/empty fallback revoking live content, user
content being changed, filesystem paths leaking into the briefing, or a
provider turn starting against a half-applied projection.

`BLOCKED` means the selected provider, Cloud Resource controls, required legacy
fixture, or isolated run-cell topology could not be made ready. `INCONCLUSIVE`
means the turn ran but available observations cannot distinguish provider
discovery from prompt-only behavior.

## Evidence

Keep sanitized Cloud Resource version/readback, provider start/resume logs,
workspace-relative directory listings, ownership-marker keys and revisions,
briefing excerpts, effective Skill names, and a short real-turn transcript
showing discovery. Record warnings and timing around configuration failure and
recovery. Do not retain absolute home paths, Skill bodies beyond disposable
fixtures, credentials, tokens, or private provider state.
