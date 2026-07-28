---
id: meeting-context-source-artifacts
description: Validate provider-agnostic meeting artifact intake, durable-decision extraction, and safe Context Tree handoff.
areas: [cross-surface]
surfaces: [runtime, client, provider, context-tree]
---

# Meeting Context From User-Supplied Artifacts

## Goal

Confirm that `return-meeting-context` analyzes only meeting artifacts the user
explicitly supplies, preserves chronology and evidence quality, excludes raw
material from persistent output, and hands only settled durable claims to
`first-tree-write`.

## Preconditions

- Run the target ref in the formal isolated Docker plus temporary-worktree
  harness.
- Prepare equivalent synthetic meeting material as a provider document,
  uploaded attachment, local file, and pasted text. Include:
  - a progress-only meeting;
  - an initial proposal explicitly replaced later in the chronology;
  - a settled durable decision with surviving rationale;
  - AI-generated notes without human confirmation;
  - an intentionally partial artifact.
- Provide artifacts directly to the task. Do not use a calendar, provider
  search, meeting discovery, or embedded links.
- Bind a disposable Context Tree for the write-intent path. Keep all raw
  meeting material outside that repository.

## Operate

- Exercise every supported input kind with analysis-only intent. Confirm that
  the reader resolves only the exact supplied artifact and the skill
  normalizes a task-local artifact bundle.
- Exercise a user-supplied multi-artifact bundle in explicit chronology order.
  Confirm that the later replacement excludes the initial proposal.
- Validate the emitted decision-evidence packet for progress-only,
  later-override, settled-decision, AI-notes-only, and partial-source cases.
- Inject an unknown output field, URL, provider ID, participant identifier,
  email, absolute path, token, exact currency amount, and raw excerpt. Confirm
  that validation fails closed.
- Repeat the settled-decision case with write intent. Confirm that the skill
  hands the validated packet and supplied artifact to `first-tree-write`,
  which owns Tree/open-proposal dedupe, target selection, current-state
  rewriting, verification, branch preparation, and the draft PR/MR.
- Confirm that the skill itself does not maintain a provider profile,
  organizer gate, discovery window, watermark, processed ledger, lock,
  persistent report, schedule, or approval state.

## Observe

- Provider and filesystem traces show no source access beyond the artifacts
  explicitly supplied by the user.
- Raw meeting content remains only in the source, conversation context, or
  task-local temporary storage and is removed through the reader's cleanup
  path.
- Complete progress-only material produces `no-change`.
- Partial or unknown material produces `blocked-source` without semantic
  analysis.
- AI-generated notes alone produce `needs-confirmation`; they never establish
  settlement.
- A settled durable decision that survives later-override checks produces
  `ready-for-write`; a replaced proposal does not appear in the packet.
- Analysis-only intent creates no Tree branch or PR/MR. Write intent crosses
  into Tree work only through `first-tree-write`.
- The Context Tree contains current durable What and Why only, never meeting
  transcripts, copied minutes, provider metadata, or execution history.

## Expected Result

`PASS`: all four input kinds obey the exact-artifact boundary; chronology,
settlement, durability, and privacy gates produce the expected packet statuses;
and only a validated write-intent packet reaches `first-tree-write`.

`FAIL`: the skill discovers another source, follows an embedded link, treats AI
notes as settlement, retains an overridden proposal, emits raw/private data,
persists meeting-processing state, or writes the Tree without the
`first-tree-write` handoff.

`BLOCKED`: an input kind, isolated reader, disposable Tree, or required
filesystem observation cannot be prepared.

`INCONCLUSIVE`: source-access traces, cleanup evidence, model invocation count,
or the boundary between this skill and `first-tree-write` cannot be observed.

## Evidence

Keep the target commit and image digest; synthetic artifact hashes and input
kinds; bundle and packet validator results; status, chronology, settlement, and
handoff observations; model invocation count; before/after source and temp
inventories; and the sanitized Tree diff when write intent is exercised. Never
retain provider IDs, meeting titles, document tokens, transcripts, AI notes,
participant identities, credentials, private links, or copied meeting prose.
