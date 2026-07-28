---
name: return-meeting-context
description: Recover settled durable decisions, constraints, and rationale from an explicitly requested, owner-scoped meeting run and produce a private sanitized report with one review candidate per coherent claim. Use for manual meeting-to-Context-Tree catch-up, meeting-source dedupe and revision recovery, or report-only evaluation. This pilot stops before tracked confirmation or Tree publication. Do not use for raw transcript archiving, progress or action-item summaries, implicit or scheduled capture, Tree writes, approval, or merge.
---

# Return Meeting Context

Turn authorized meeting evidence into reviewable Context Tree candidates without
copying raw meeting material into the Tree.

## Preserve the boundary

- Require an explicit request from the local provider-profile owner for every
  live run. Bind it to the requested time window, owner-scoped sources, and
  declared purpose. Local provider capability or a saved config is not source
  authorization.
- This version does not create or rely on persistent source grants or schedules.
  Stop if the requesting human cannot be established as the configured profile
  owner; do not infer authorization from calendar visibility.
- Keep transcripts, AI notes, provider responses, participant identifiers,
  progress, plans, blockers, and risks in the source system or run-lifetime
  private temporary storage.
- Never put raw meeting material in the Context Tree, a source repository,
  a Tree PR/MR body, or a normal chat reply.
- Treat a meeting as evidence, never as approved organizational truth.
- Stop at a private sanitized report. This pilot does not send confirmation
  asks or call `first-tree-write`.
- Never change `owners`, create a top-level Tree domain, mark a Tree PR ready,
  approve, repair, or merge it through this skill.
- Treat no-change, already-present, already-proposed, revisit, skip, and
  blocked-source as valid outcomes.

## Choose the entry path

When a Context Tree is bound, load and follow `first-tree-read` before capture.
Use that workflow's exact task snapshot commit as `tree_main_commit`; do not
invent a SHA or substitute a mutable branch name. Use the same snapshot for
semantic dedupe throughout the run.

### Provider-normalized pilot

Start from a capture manifest that follows
[contracts.md](references/contracts.md). Run:

```sh
node scripts/prepare-run.mjs --config <private-config.json> --capture <private-capture.json>
```

The deterministic runner applies the owner and completeness gates before
reading source files. Incomplete meetings become metadata-only
`blocked_meetings` and are never model-facing. Complete meetings are assembled
into a mode-`0600` ordered projection, compared with the private processed
ledger, and returned through `analysis_input_path`.

A normalized manifest is not provider authorization or proof of owner
provenance by itself. Use this path only for synthetic evaluation or an
authorized provider adapter whose identity and lineage gates are independently
established. For live Feishu, use the bundled Feishu collector rather than a
handwritten manifest.

If `changed_meeting_count` is zero, do not invoke a model and do not bother a
human. Validate an output with an empty `meeting_results` array and finalize
directly; the finalizer adds deterministic `blocked-source` results for any
`blocked_meeting_count`.

### Feishu discovery

Read [feishu-adapter.md](references/feishu-adapter.md) before fetching Feishu
sources. Keep provider commands read-only, write artifacts only beneath the
run-lifetime temp directory, and fail closed when organizer ownership or
chronology cannot be proven.

Plan the bounded window from the private watermark:

```sh
node scripts/plan-window.mjs \
  --config <private-config.json> \
  --end <manual-run-end-ISO>
```

Use the returned start/end exactly. The configured overlap makes late provider
updates visible; source revision dedupe prevents duplicate model work.

For the validated calendar → notes → transcript path, run:

```sh
node scripts/collect-feishu.mjs \
  --config <private-config.json> \
  --start <planned-ISO> \
  --end <planned-ISO> \
  --run-key <manual-run-key> \
  --tree-main-commit <exact-40-hex-sha>
```

Immediately pass the returned `capture_path` to `prepare-run.mjs`.
`prepare-run.mjs` deletes the ephemeral provider capture after creating its own
run-lifetime projection. If preparation cannot start, run:

```sh
node scripts/cleanup-capture.mjs --capture <capture.json>
```

Do not guess undocumented Feishu fields or weaken the owner gate to make
discovery succeed. The adapter does not use title/body inference, `vc
+recording`, `minutes +search`, or an unverified VC search result as proof that
a meeting source is complete.

When no Context Tree is bound, omit `--tree-main-commit`. The run may still
report `no-change`, `revisit`, `skip`, or `blocked-source`, but the validator
will reject `draft-eligible`, `already-present`, and `already-proposed` claims
without an exact Tree snapshot.

## Analyze every changed meeting

Read the complete temporary chronology for each changed meeting. AI summaries
may guide navigation but do not establish settlement.

For every candidate:

1. Apply the Context Tree Decision Test and Durability Test.
2. Separate durable current-state claims from progress, tasks, logistics,
   plans, risks, and unresolved discussion.
3. Require settlement evidence: an explicit human choice, approval of a
   complete proposal, a terminal artifact that establishes the contract, or
   repeated consistent human direction with no later withdrawal.
4. Scan the full chronology and later sources for correction, supersession,
   disagreement, `stop`, `ignore`, `freeze`, `redo`, or unresolved asks.
5. Read current normal Tree content and open Tree PR/MR proposals before
   selecting a disposition or target.
6. Preserve the surviving rationale. Do not return a bare fact.
7. Produce one candidate per coherent decision.

Use these candidate dispositions:

- `draft-eligible`
- `already-present`
- `already-proposed`
- `revisit`
- `skip`
- `blocked-source`
- `failed`

Use `revisit` with one concrete re-evaluation trigger when settlement,
chronology, target routing, or dedupe remains incomplete.

## Emit and validate report-only output

Write one analysis output JSON inside the returned run directory using the
schema and examples in [contracts.md](references/contracts.md). Cover every
changed meeting, including meetings with no candidates.

Validate it deterministically:

```sh
node scripts/validate-output.mjs \
  --analysis-input <analysis-input.json> \
  --output <analysis-output.json>
```

The validator binds every candidate to the exact meeting source revision,
normalizes candidate IDs and claim hashes, rejects raw-shaped fields and
suspicious unredacted values, and blocks `draft-eligible` when source,
settlement, chronology, target, or dedupe gates are incomplete.

Do not show evidence excerpts in ordinary chat unless a human explicitly needs
them to decide and the excerpt is already minimal and redacted.

## Finalize the report-only run

After every changed meeting has a validated disposition, finalize immediately:

```sh
node scripts/finalize-run.mjs \
  --analysis-input <analysis-input.json> \
  --validated-output <validated-output.json>
```

The finalizer advances only safe ledger states, writes a private sanitized
report, removes the run-lifetime raw projection, and releases the run lock.
Never wait for a human while retaining transcript temp files.

Use only the default dedicated temp root or an explicit private directory whose
basename starts with `return-meeting-context` and that remains strictly beneath
the operating-system temp directory. Existing shared or symlinked directories
are rejected rather than permission-rewritten.

If analysis cannot finish, run:

```sh
node scripts/abort-run.mjs --analysis-input <analysis-input.json>
```

This removes the temp projection and releases the lock without advancing the
watermark.

## Stop at the report-only pilot boundary

Return only the sanitized run summary and candidate count in ordinary chat.
Keep the detailed report in the configured private state directory. Do not
send a tracked confirmation ask, create a Tree packet, call `first-tree-write`,
or open a Tree PR/MR.

`draft-eligible` means only that the candidate passed the analysis gates and is
worth evaluating in a later confirmation phase. It is not approval and is not
publishable.

The next phase requires a server-authenticated tracked-answer receipt that
binds the exact ask, recipient, selected option, candidate revision, claim
hash, and current source revision. A caller-provided message ID or plain chat
reply is not sufficient. Until that receipt exists and receives live formal
QA, this skill remains report-only.

## Validate skill changes

Run:

```sh
node skills/return-meeting-context/scripts/test.mjs
python3 scripts/quick_validate_skill.py skills/return-meeting-context
```

Use [eval-cases.md](references/eval-cases.md) for semantic forward tests. The
deterministic suite owns privacy, owner gate, profile binding, segment assembly,
revision idempotency, output coverage, and cleanup. Agent evals own settlement,
later override, Double Test, semantic dedupe, rationale retention, and
no-change correctness.
