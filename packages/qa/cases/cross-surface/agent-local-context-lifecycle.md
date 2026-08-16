---
id: agent-local-context-lifecycle
description: Validate Agent-private Local Context fallback across two Chats, two Agents, same-name Skill replacement, missing Git, binding flip, crash repair, and deletion warnings.
areas: [cross-surface]
surfaces: [cli, client, server, runtime]
---

# Agent Local Context Lifecycle

## Goal

Confirm that an Agent whose Team has no remote Context Tree binding can create,
read, and write a live Tree at `<agent-workspace>/local-context/` without Git,
that the same Agent's Chats share that directory, that a different Agent never
receives it, and that observing a remote binding freezes Local without upload
or automatic reactivation.

Deterministic product tests own wire classification, latch monotonicity, Skill
variant revision, identity/path fences, and filesystem hierarchy mode. This
case owns the assembled runtime session, CLI guard, Skill projection, and
lifecycle-delete warning path on a real candidate home.

## Preconditions

- Isolated candidate CLI, daemon, and server with a throwaway Team that has
  **no** Cloud Context Tree binding. Do not reuse the operator home.
- Two managed Agents in that Team on one Client, each with its own workspace.
- A second Chat on the first Agent. Git may be present on the host; also
  prepare a PATH that cannot spawn `git` for the no-Git branch.
- Do not enable Web Context status, Context Reviewer, Audit, or Seed against
  the Local directory.

## Operate

- Start both Agents. Confirm each workspace contains `local-context/` after
  the first Local Read or Write, and that the two directories are distinct.
- In two Chats of the first Agent, read and then write the same live node.
  Last-write-wins is allowed. Do not expect a content lock, snapshot, or
  rollback. After each successful write, `tree verify --tree-path` must pass.
- Interrupt a write mid-edit so the Tree is mechanically invalid. The next
  Local Read must refuse. The next Local Write must be able to repair.
- Before binding remote, switch to another Client identity and back. The whole
  Agent Workspace, including `local-context/`, must park and restore intact;
  there is no Local-specific copy or move path.
- Bind a remote Context Tree for the Team. The next Local resolve must freeze.
  The next Skill projection must replace Local Read/Write payloads with the
  public remote payloads under the same names. The Local directory remains on
  disk and must not be uploaded or merged.
- After the remote latch exists, restart a Chat that previously ran in Local
  mode. Manifest `tree` must stay `context-tree`, and projected Skills must
  stay remote.
- With a completed non-none projection and an existing remote-observed latch,
  exercise an authoritative unbound response and a binding request that ends
  unknown. Neither case may reactivate the old Remote source or enable Local.
  Provider admission must fail closed, while the existing Skill, manifest,
  identity, briefing, and sentinel bytes remain unchanged.
- `agent remove`, `agent prune`, `logout --purge`, and `computer reset` must
  warn about unmigrated Local Context before deleting active or parked
  workspaces.

## Evidence

- Workspace paths, `workspace.json` `tree` values, and Skill revision markers
  (`local-context:<version>` vs public version) before and after the binding
  flip.
- Byte hashes for the completed non-none Skill, manifest, identity, briefing,
  and sentinel projection before and after authoritative unbound/unknown with
  an existing latch, plus the provider-admission fail-closed result. The hashes
  must remain identical; latch coordinates are observation evidence, not
  authority to restart the old Remote source.
- CLI human or JSON output from `tree local resolve --ensure --intent read|write`
  including freeze/error codes.
- `tree tree --tree-path` output in filesystem mode (`Mode: filesystem`, no
  Branch line) with Git removed from PATH.
- Deletion warning text from remove/prune/purge/reset, including parked Client
  Local Context for purge/reset.
- No Cloud Context Tree IO events, Git attribution, Reviewer, Audit, or Web
  Local status for the Local path.

## Expected

Local Context is Agent-private, lockless, and Git-free. The Workspace
remote-observed latch is monotonic: once recorded, Local cannot be reactivated
automatically. The remote binding itself may be removed or changed, and the
latch is not a lease for restarting an old Remote source. Authoritative
unbound/unknown with a latch preserves an existing non-none projection but
fails provider admission. Missing `bindingState`, `invalid`, and transport
failure never create Local. V0 has no Web surface and no automatic migration
onto the remote Tree.
