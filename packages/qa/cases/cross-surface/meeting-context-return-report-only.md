---
id: meeting-context-return-report-only
description: Validate explicit owner-scoped Feishu capture, private raw cleanup, and sanitized report-only meeting context return.
areas: [cross-surface]
surfaces: [runtime, client, provider, context-tree]
---

# Meeting Context Return Report-Only Pilot

## Goal

Confirm that an explicitly requested `return-meeting-context` run reads only
meetings organized by the authenticated Feishu profile owner, keeps raw meeting
material outside source repositories and the Context Tree, produces only a
sanitized private report, and cleans every raw artifact on success and failure.

The shipped pilot ends at report-only. A tracked confirmation ask,
`first-tree-write`, and Tree PR/MR creation are forbidden in this case. A later
publication phase needs a separate case after a server-authenticated
tracked-answer receipt exists.

## Preconditions

- Run the target ref in the formal isolated Docker plus temporary-worktree
  harness. Use a narrowly scoped native provider bridge only for the local
  `lark-cli` profile; do not copy provider credentials into the container or
  run artifacts.
- Use a throwaway or explicitly authorized Feishu user profile with at least
  one meeting organized by that user, one participant-visible meeting
  organized by someone else, one progress-only meeting, and one owned meeting
  whose transcript source is intentionally incomplete or revised during the
  run.
- The profile owner must explicitly request one bounded time window and the
  report-only purpose in the First Tree chat. Calendar visibility, a saved
  config, a prior run, or provider capability is not authorization.
- Bind a real disposable Context Tree or a read-only test Tree snapshot so the
  candidate analysis can exercise current normal content and open-proposal
  dedupe. Record the exact Tree main commit without copying raw meeting
  evidence into that repository.
- Put private state and operating-system temp roots outside source worktrees.
  Capture filesystem events or before/after inventories for those roots,
  source repos, the Tree checkout, and the chat attachments directory.

## Operate

- Start one manual run from the authorized chat message. Verify that the
  requested time window, purpose, local profile, and configured owner are
  visible before provider access.
- Observe the profile self-identity lookup, bounded calendar discovery, and
  organizer gate. The participant-visible non-owned meeting must not trigger a
  notes or document fetch.
- For the owned meeting, observe exact calendar-event → meeting →
  transcript-token lineage, provider revision or complete v1 pagination,
  multi-segment ordering, and content hashing. Missing or conflicting lineage
  must stop before transcript fetch.
- Change the configured owner to a different visible organizer and repeat. The
  authenticated-profile mismatch must stop before calendar discovery.
- Exercise success, progress-only, incomplete-source, provider-command
  failure, validator rejection, explicit abort, stale lock recovery, and a
  valid custom OS-temp root. Include shared and symlinked temp-root negatives,
  confirm their permissions remain unchanged, and include a source path whose
  parent symlink escapes the configured private root on platforms that support
  symlinks.
- Run the same unchanged source revision again. It must take the no-model fast
  path. Then revise the owned source and confirm it re-enters analysis without
  reusing the prior disposition as approval.
- Inspect the sanitized report for durable What, surviving Why, target hint,
  source revision, claim hash, and disposition. Inject an unknown output field,
  URL, provider ID, email, phone number, currency amount, and oversized excerpt
  and verify fail-closed rejection.
- Confirm that the run sends no tracked ask, invokes no `first-tree-write`,
  creates no Tree branch or PR/MR, and performs no approval or merge action.

## Observe

- Provider traces show one immutable self-identity check before discovery and
  no raw fetch for profile mismatch, organizer mismatch, missing owner, or
  incomplete note lineage.
- Raw provider responses and transcript projections exist only under
  mode-restricted OS temp roots during the active run. Finalize and abort remove
  them before releasing the run lock; cleanup failure cannot advance the
  source revision or discovery watermark.
- Persistent private state contains hashes, revisions, dispositions,
  watermarks, run keys, and sanitized reports only. It contains no transcript,
  AI notes, provider response, participant identifier, private URL, speaker
  map, or approval state.
- Partial or incomplete sources resolve to meeting-level `blocked-source` and
  preserve the prior safe watermark without opening raw segment files or
  invoking semantic analysis. Progress-only complete sources resolve to
  `no-change`. Unchanged revisions do not invoke semantic analysis.
- Source repos, the Context Tree checkout, Tree provider state, normal chat
  messages, and attachments contain no raw meeting material and no changes
  created by the skill.

## Expected Result

`PASS`: live provider and filesystem evidence proves explicit bounded
initiation, authenticated profile-owner binding, pre-raw organizer/lineage
gates, deterministic revision behavior, strict sanitized output, complete raw
cleanup, and the report-only publication boundary.

`FAIL`: the run reads a non-owned meeting, trusts a configured owner without
binding it to the authenticated profile, fetches raw before lineage is proven,
persists or sends raw/private material, advances incomplete source state,
leaves raw after finalize/abort, treats a prior run as authorization, or
creates any confirmation/Tree publication side effect.

`BLOCKED`: the isolated harness, authorized provider profile, representative
meeting fixtures, provider bridge, filesystem observation, or disposable Tree
snapshot cannot be prepared.

`INCONCLUSIVE`: provider or filesystem traces are incomplete, the owner and
non-owner paths cannot both be observed, cleanup cannot be verified after both
success and failure, or only synthetic behavior is available.

## Evidence

Keep the target commit and image digest; the explicit authorization message ID
and redacted window/purpose; sanitized provider call names and owner-gate
outcomes; source revision transitions; before/after private-state and temp-root
inventories; sanitized report fields and negative-validation results; model
invocation count; and proof of no Tree/git/chat publication side effects.
Never retain provider IDs, meeting titles, document tokens, transcripts, AI
notes, participant identities, credentials, links, or private meeting prose.
