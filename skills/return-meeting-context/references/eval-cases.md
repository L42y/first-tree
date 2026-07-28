# Meeting Context Return Eval Cases

## Deterministic suite

Run `node scripts/test.mjs`. It must cover:

1. owner match is processed;
2. owner mismatch is skipped before its source file is opened;
3. missing owner is skipped;
4. two transcript segments are ordered by timestamp;
5. identical source revision is a no-model fast path;
6. changed content or provider revision reopens analysis;
7. partial chronology remains metadata-only, does not invoke semantic
   analysis, and becomes deterministic `blocked-source`;
8. stale source revision is rejected;
9. missing meeting result is rejected;
10. raw-shaped fields, provider IDs, URLs, secrets, and unredacted amounts are
    rejected;
11. oversized evidence is rejected;
12. finalize removes raw temp files and advances safe ledger states;
13. abort removes raw temp files without advancing state.
14. Feishu parser rejects item/envelope errors and incomplete v1 pagination.
15. the authenticated Feishu profile identity must match the configured owner
    before calendar discovery;
16. Feishu owner filtering happens before notes or document fetch, and missing
    calendar/meeting/token lineage never fetches raw;
17. ephemeral capture artifacts are deleted after prepare or explicit cleanup.
18. discovery windows start from bootstrap once, then the last safe watermark
    with the configured overlap.
19. invalid temp-root configuration fails before lock acquisition and leaves
    no lock or run artifact.
20. partial or incomplete meeting sources never advance their source revision
    or discovery watermark, including when classified as `revisit`.
21. valid custom temp roots clean raw before state advancement and lock release;
22. canonical path checks reject source-root symlink escapes;
23. lock acquisition permits only one concurrent run;
24. unknown output fields and common PII shapes are rejected instead of being
    persisted into the private report.
25. invalid settlement/dedupe value types and non-empty non-`revisit`
    triggers are rejected;
26. shared, symlinked, or non-dedicated temp roots are rejected without
    permission changes, lock acquisition, or provider reads.

## Semantic forward tests

Use sanitized synthetic meetings. Never use live raw meeting content in an eval
artifact.

### S1 — Progress-only meeting

Input: status updates, short-term plans, blockers, and task assignments.

Expected: no durable candidate; `no-change` or all candidates `skip`.

### S2 — Explicit final decision

Input: a human owner compares two options, chooses one, states the durable
constraint and rationale, and no later source overrides it.

Expected: one coherent `draft-eligible` candidate with What and Why.

### S3 — Agent suggestion without human settlement

Input: an agent recommends a durable architecture; humans discuss it but do not
approve a complete proposal.

Expected: `revisit`, not `draft-eligible`.

### S4 — Next-day override

Input: day one settles option A; day two explicitly replaces it with option B.

Expected: A is not promoted; only B may be eligible after full chronology.

### S5 — Existing Tree truth

Input: settled meeting decision whose What and Why are already present in normal
Tree content.

Expected: `already-present`.

### S6 — Open proposal duplicate

Input: a matching open Tree PR already proposes the same decision.

Expected: `already-proposed`.

### S7 — Partial source

Input: AI notes exist but one transcript segment or associated source is
missing.

Expected: no raw segment is opened and no semantic model is invoked;
meeting-level `blocked-source`; never `no-change`, `revisit`, or
`draft-eligible`.

### S8 — Unknown speaker

Input: an important statement is attributed only to `Speaker 2`.

Expected: do not guess identity; settlement requiring that speaker is blocked
until ownership is established.

### S9 — Borrowed device

Input: a known member speaks through another participant's device and the
meeting explicitly identifies the borrowing.

Expected: preserve the attribution qualification; do not silently rewrite the
speaker identity.

### S10 — Sensitive commercial detail

Input: the durable decision includes a customer name and exact amount, but the
general rationale can survive without them.

Expected: typed redaction/minimization; no sensitive values in the packet or
Chat ask.

### S11 — Current-state rewrite

Input: a confirmed decision supersedes an existing normal Tree claim.

Expected: one candidate describing the new current state and surviving
rationale, not a dated append.

## Quality metrics

Record:

- false promotion rate;
- no-change correctness;
- already-present and already-proposed precision;
- settlement/revisit accuracy;
- later-override recall;
- Why retention;
- raw Tree write count;
- redaction escape count;
- blocked-source recovery rate.
