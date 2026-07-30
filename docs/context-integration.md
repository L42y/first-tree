# External Context Integration

First Tree Context integration lets a person's existing Claude Code or Codex
session read and propose source-backed updates to one explicit Team's Context
Tree. It does not turn that provider session into a First Tree Agent or connect
its conversation to First Tree Chat.

## Support matrix

| Surface | macOS arm64/x64 | glibc Linux arm64/x64 | Windows | Remote/cloud session |
| --- | --- | --- | --- | --- |
| Claude Code CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| Claude Desktop local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |
| Codex CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| ChatGPT Desktop Codex local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |

Windows is not excluded because of Claude or Codex. First Tree does not yet
ship the required Windows portable binary, installer, path handling, and
native/WSL qualification. Remote provider environments also need a separate
credential, local-project identity, and provider host-signal design.

Minimum provider versions are recorded in the Context integration release
manifest embedded in every npm and portable distribution. The portable
manifest also records both adapter digests and the canonical Policy digest.

## Runtime contract

- Web Setup and onboarding provide one provider-neutral prompt. The current
  coding agent selects `codex` or `claude-code` from its own host identity,
  never from installed binaries. Codex runs the handoff unchanged so the CLI
  applies its centralized classifier. Claude Code appends one host-confirmed
  path/pathless selector because ordinary shell commands are not guaranteed to
  receive the hook-only `CLAUDE_PROJECT_DIR` signal. Neither flow derives a
  project root from Git or mutable shell cwd.
- `context enable` installs the user-scope Plugin and binds the resolved
  canonical project path or the provider's single pathless project to the
  handoff-selected Team. A path project may be an ordinary directory containing
  zero, one, or many source repositories. Explicit selector flags remain
  required when a provider's ordinary shell does not expose stable project
  identity, and are reused from the first activation receipt after shell cwd
  changes.
- `config/context.yaml` schema v2 stores only
  `provider + project(path|pathless) → organizationId`. It never stores source
  repository identity or a Context Tree remote/local snapshot path.
- Live activation calls
  `POST /api/v1/orgs/:orgId/context-activation/validate`; the URL carries the
  handoff-selected Team and the v2 body carries only `schemaVersion`. The
  Server resolves current membership from the path org and validates the
  Team's current Context Tree readiness. Source repositories do not need Team
  resources.
- SessionStart handles startup, resume, clear, and compact. Claude Code resolves
  the attached project from `CLAUDE_PROJECT_DIR`. Codex uses a versioned
  best-effort classifier: known `$Documents/Codex/YYYY-MM-DD/<slug>` scratch
  paths are pathless, while other hook `cwd` values are path candidates. The
  first result is cached by session id. Pathless and unknown sessions never
  auto-activate.
- A connected SessionStart always carries the same source-artifact routing
  contract as the Managed briefing. Its non-exhaustive automatic examples are
  PR/MR, forge Issue, design document, meeting or decision note, commit
  discussion or review thread, and pasted source. When one changes a durable
  decision, constraint, owner, or cross-domain relationship, the provider
  loads `first-tree-write`. Implementation-only artifacts do not produce a
  Tree write, and no Tree write task exists before a concrete source artifact
  does. A just-completed local source change is not promoted to this generic
  route, and Audit findings continue through their dedicated Maintenance
  handoff; the Skill's accepted-source gate remains broader.
- External write intent comes only from an explicit Tree-write request or that
  connected SessionStart standing route classifying a concrete artifact as
  durable Tree work. Permission to publish a source PR/MR is not a separate
  transitive Tree-write intent rule.
- External Read and Write never accept a Team argument. Their provider-specific
  hidden routes derive Team from the current provider + project binding and
  repeat the same live activation before every Read, initial Write authoring,
  push, and PR/MR creation.
- Activation failure never blocks ordinary provider work and never falls back
  to another Team or cached authority.
- SessionStart uses one non-retrying two-second live-authority attempt covering
  access-token refresh and the validator request inside a five-second provider
  hook budget, so timeout or network failure can return a controlled
  unavailable envelope instead of being killed by the provider. Explicit
  status, Read, and Write activation use a five-second attempt covering the
  same two stages and retry the same exact Team once only for
  timeout, network, or HTTP 5xx failures. Authentication, authorization,
  binding, scope, and typed disabled results never retry. Failures expose
  stable timeout, network, server, or rejection reason codes without returning
  cached authority.
- Read does not depend on Reviewer readiness. A new official Write fails before
  remote mutation when Automatic Review is absent, disabled, structurally
  incomplete, or offline.
- When source and Tree PRs/MRs are both required, create and cross-link both,
  keep the Tree change draft, merge source first, reconcile the Tree change
  against merged source truth, and only then mark it ready. SessionStart
  classification never replaces the existing live preflight, Reviewer, forge
  identity, or exact-binding authority gates.

## Codex Hook consent and verification

Codex owns Hook consent. First Tree installs the Plugin but never bypasses,
pre-approves, or silently enables the SessionStart Hook. After the first
path-project `context enable --provider codex`:

1. open Codex in the enabled project;
2. run `/hooks`;
3. find **First Tree Context → SessionStart**, enable its checkbox, and choose
   **Trust**;
4. exit and start a new Codex session in that project;
5. run `first-tree context status --provider codex` and confirm **Hook trusted**
   and **Hook enabled** are `Yes`, and **Live activation** is `Connected`.

Both `context enable` and `context status` query Codex's provider-owned
`hooks/list` API after installation. They report trust and enablement
separately, including a Hook that changed after approval. A previously trusted
and enabled Hook therefore does not receive another review prompt.

Pathless Codex projects activate through the bundled `first-tree` Skill and do
not require Hook consent for `Setup: Complete`.

Status output also keeps machine/user/provider and project authority
separate: provider compatibility, Plugin installation, Plugin enablement,
Hook trust, Hook enablement, current project, project binding, and live Team
activation each have their own row.

## Upgrade, rollback, and disable

`first-tree context repair --provider <provider>` validates the embedded
release, stages the provider marketplace, and preserves the current installed
Plugin before attempting replacement. The local install manifest changes only
after the provider reports the new Plugin installed and enabled. On failure,
First Tree reinstalls the preserved provider cache; if that rollback also
fails, it reports both failures and leaves `context repair` as the explicit
recovery path.

Provider CLIs retain a reference to the local marketplace used during
installation. First Tree therefore keeps that required source at
`$FIRST_TREE_HOME/state/context/providers/<provider>/marketplace`; the
provider continues to own its installed Plugin cache. Repair atomically
replaces or restores this source, and successful uninstall removes it. This is
machine state required by the provider lifecycle, not a second release cache
or a new top-level First Tree directory.

Enable uses one operation coordinator across provider Plugin state, the First
Tree install manifest, and `config/context.yaml`. Its recovery journal records
the prior bindings, prior manifest, and provider rollback source until every
side commits. Repair uses the same durable coordinator, so an interrupted
reinstall is recoverable rather than being represented only by the inner
installer journal. Disable is a separate binding-only transaction: it never
reads or mutates provider Plugin state.

Context mutations and local Client account switching share one machine-state
lock. An operation journal records the exact active Computer identity, and
recovery refuses to restore bindings under a different logged-in account.
Likewise, login/account switching refuses to move `context.yaml` while a
Context install, enable, disable, repair, or recovery is active.
An installed-but-disabled provider Plugin is rejected before any local
mutation because its prior enabled state cannot be restored portably through
the supported provider CLI.

`first-tree context disable --provider <provider>` resolves the current
path/pathless project and removes only its effective binding. A path project
uses the deepest matching ancestor binding; pathless removes only the
provider's pathless binding. No match returns idempotent `Already disabled`.
After removing a nested binding, the same queried path is resolved again. If a
parent binding becomes effective, the result is `fallback_active`, names that
Team/root, and gives the same command as the next one-binding removal action;
it never claims the project is disabled while a fallback remains.
The provider Plugin, marketplace, login credentials, other project bindings,
and First Tree Client daemon are preserved. Context already injected into the
current session cannot be revoked; the change applies to future sessions and
explicit activations.

An older First Tree binary may reject a newer embedded Plugin manifest. Restore
the matching First Tree release first, then run `context repair`. Never edit
Claude/Codex provider caches or `$FIRST_TREE_HOME/state/context` by hand during
normal recovery.

`context status`, SessionStart, and the hidden Read/Write routes compare the
installed bundle, Policy, and adapter digests with the current CLI's embedded
release. They also verify the complete materialized Plugin source and the
provider-owned installed cache, including all three Skills, both Policy projections,
the launcher, and the hook definition. Install commits its ready manifest only
after the provider's actual installed path matches that payload. The same gate
enforces the provider minimum version. Any manifest, source, or provider-cache
drift returns `continue: true`, tells the user ordinary provider work can
continue, and gives the Agent the channel-specific repair command. The Agent
must not run it until the user explicitly asks to repair, upgrade, or
synchronize First Tree Context.

The canonical Context Tree Policy and source-artifact Write routing contract
each have one source file. Managed workspaces receive both in the generated
briefing; connected External sessions receive the routing contract at
SessionStart, while External Claude and Codex bundles receive the same Policy
bytes under each projected Read/Write Skill. The generated External Skills also
share one canonical source template; their reproducible provider projections
may differ only in the fixed adapter routing needed to resolve the exact
`provider + project` binding. The External projection adds the mandatory
lazy-load reference, while Managed Skills continue to rely on the
always-present briefing and never depend on a Plugin-only relative file.

## Release qualification

Before production rollout, exercise each P0 surface with a staging Team and an
ordinary project containing zero or multiple source repositories:

1. ordinary startup with no binding, a pathless session, and an unknown project;
2. path-project enable, startup, resume, clear, and compact;
3. exact-snapshot Read and source-backed Write;
4. membership revocation and source repositories absent from Team resources;
5. server offline and provider hook rejection;
6. Reviewer missing, disabled, structurally incomplete, and offline;
7. stale Plugin continuation, explicit-user-only repair, forced install
   failure/rollback, and disable;
8. byte parity of managed briefing, Claude Plugin, and Codex Plugin Policy;
9. GitHub PR and GitLab MR review/repair/merge through the Managed Reviewer.

Production release remains blocked until these real-surface checks pass for
all supported architectures. Unit tests and package validation do not replace
that qualification.

## Compatibility removal

The Server temporarily accepts activation request v1 so older released Clients
can roll forward safely. Its `repositoryKey` is syntax-checked for wire
compatibility but is not queried or used for authorization, and the response
retains schema version 1. New Clients send only v2.

Track removal in an explicit follow-up and remove v1 only after both conditions
hold: two consecutive public releases have shipped with v2 callers, and
telemetry shows v1 compatibility traffic has reached zero. The local
`context.yaml` v1 migration remains a one-way, backup-preserving file
migration; it is not a second runtime model.
