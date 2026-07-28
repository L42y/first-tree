# Meeting Context Return Contracts

## Contents

- Private config
- Provider-normalized capture
- Analysis input
- Analysis output
- Candidate gates
- Persistent state

## Private config

Keep this file outside the Context Tree, source repos, and shared workspaces.
Provider IDs are private routing data.

`plan-window.mjs` starts from the last safely advanced
`discovery_watermark.calendar_end`, or `bootstrap_start` on the first run, then
subtracts the bounded overlap. Revision dedupe absorbs the intentional overlap.

```json
{
  "schema": "return-meeting-context.config.v1",
  "profile": "member-agent",
  "provider": "feishu",
  "owner": {
    "member_id": "tree-member-id",
    "provider_id": "<provider-owner-id>"
  },
  "feishu": {
    "cli_path": "lark-cli",
    "profile": "<local-lark-cli-profile>"
  },
  "discovery": {
    "bootstrap_start": "2026-07-01T00:00:00.000Z",
    "overlap_seconds": 300
  },
  "state_dir": "/absolute/private/state/return-meeting-context/member-agent",
  "allowed_source_roots": [
    "/absolute/private/provider-cache"
  ],
  "retention": {
    "max_excerpt_chars": 600,
    "max_evidence_items": 3
  },
  "review": {
    "max_candidates_per_run": 3
  }
}
```

## Provider-normalized capture

The provider adapter creates this manifest. It references raw segment files but
does not inline their content.

The bundled Feishu collector additionally includes `adapter` metadata and an
`ephemeral_root` beneath the operating-system temp directory. `prepare-run.mjs`
deletes that root after copying the exact source projection into its own run
directory.

Runtime temp roots use dedicated `return-meeting-context*` directory names
strictly beneath the operating-system temp directory. Existing roots must
already be real, private directories; the runner rejects symlinks or
group/other-accessible roots without changing their permissions.

```json
{
  "schema": "return-meeting-context.capture.v1",
  "profile": "member-agent",
  "provider": "feishu",
  "captured_at": "2026-07-28T08:00:00.000Z",
  "run_key": "<manual-run-key>",
  "discovery_complete": true,
  "discovery_watermark": {
    "calendar_end": "2026-07-28T08:00:00.000Z"
  },
  "tree_main_commit": "<40-hex-commit>",
  "meetings": [
    {
      "provider_meeting_id": "<stable-meeting-id>",
      "calendar_event_id": "<stable-calendar-instance-id>",
      "owner_provider_id": "<provider-owner-id>",
      "title_hint": "Team meeting",
      "started_at": "2026-07-28T02:03:00.000Z",
      "ended_at": "2026-07-28T03:12:00.000Z",
      "source_status": "complete",
      "source_refs": [
        {
          "kind": "calendar-event",
          "id": "<stable-calendar-instance-id>",
          "revision": "<provider-revision>"
        }
      ],
      "segments": [
        {
          "source_id": "<transcript-segment-id-1>",
          "source_revision": "<provider-revision-1>",
          "started_at": "2026-07-28T02:03:00.000Z",
          "ended_at": "2026-07-28T03:03:00.000Z",
          "text_file": "/absolute/private/provider-cache/segment-1.txt"
        },
        {
          "source_id": "<transcript-segment-id-2>",
          "source_revision": "<provider-revision-2>",
          "started_at": "2026-07-28T03:03:00.000Z",
          "ended_at": "2026-07-28T03:12:00.000Z",
          "text_file": "/absolute/private/provider-cache/segment-2.txt"
        }
      ]
    }
  ]
}
```

Apply the owner gate before opening any `text_file`. `owner_provider_id` must
match the configured owner exactly. Missing ownership is not permission.

`source_status` is one of:

- `complete` — every expected source and segment is present;
- `partial` — some source path failed or chronology may be incomplete;
- `failed` — no safe analysis input can be assembled.

Advance `discovery_watermark` only after complete discovery and safe
classification of every changed meeting. A failed/blocked source preserves the
prior watermark. `run_key` is durable idempotency metadata, not authorization
to publish.

## Analysis input

`prepare-run.mjs` returns a path to this run-lifetime file. It contains
metadata plus `transcript_path` pointers beneath a private mode-`0700` temp
directory. Never persist or attach this file.

The source revision is a deterministic hash of stable meeting metadata, source
refs, provider revisions, segment ordering, and segment content hashes.

Only complete, owner-matched meetings appear in `analysis-input.meetings` and
become model-facing. Incomplete chronology appears in
`analysis-input.blocked_meetings` as metadata and a deterministic
`blocked-source` reason; `prepare-run.mjs` does not open its raw segment files.
The finalizer adds these blocked results to the private report and does not
advance their source revision or the discovery watermark.

## Analysis output

Cover every meeting in `analysis-input.meetings` exactly once:

```json
{
  "schema": "return-meeting-context.analysis-output.v1",
  "run_id": "<run-id>",
  "tree_main_commit": "<exact-analysis-input-commit>",
  "meeting_results": [
    {
      "meeting_id": "<stable-meeting-id>",
      "source_revision": "<exact-analysis-input-revision>",
      "disposition": "candidates",
      "reason": "A settled durable decision survives the later chronology.",
      "candidates": [
        {
          "candidate_revision": 1,
          "disposition": "draft-eligible",
          "claim": {
            "what": "Current durable decision in present tense.",
            "why": "Surviving rationale that explains the constraint or trade-off.",
            "constraints": [
              "A durable implementation-independent boundary."
            ]
          },
          "target": {
            "path_hint": "product/example/decision.md"
          },
          "settlement": {
            "status": "settled",
            "evidence": [
              {
                "source_ref": "transcript-segment:<typed-id>",
                "excerpt": "<short-redacted-excerpt>"
              }
            ],
            "confirmation_member_ids": [
              "tree-member-id"
            ]
          },
          "chronology": {
            "later_override_checked": true
          },
          "dedupe": {
            "tree_main_checked": true,
            "open_proposals_checked": true,
            "status": "absent"
          },
          "revisit_trigger": ""
        }
      ]
    }
  ]
}
```

For a meeting with no Tree-worthy content:

```json
{
  "meeting_id": "<stable-meeting-id>",
  "source_revision": "<exact-revision>",
  "disposition": "no-change",
  "reason": "Only progress updates and unsettled plans were present.",
  "candidates": []
}
```

Never emit `candidate_id` or `claim_hash` yourself. The validator derives both
from the normalized claim and meeting ID.

## Candidate gates

`draft-eligible` requires all of:

- an exact 40-hex Tree main commit for the analyzed snapshot;
- complete provider source and chronology;
- settled conclusion;
- later-override scan complete;
- current Tree main checked;
- open Tree proposals checked;
- semantic duplicate absent;
- smallest existing target path selected;
- What and Why both present.

The output validator rejects:

- `draft-eligible`, `already-present`, or `already-proposed` without an exact
  40-hex Tree main commit;
- fields named like transcript/raw/AI notes/open_id/provider identity;
- URLs, provider IDs, common secret shapes, and unredacted currency amounts;
- evidence exceeding configured item or character limits;
- stale meeting source revisions;
- missing meeting results;
- `draft-eligible` with any incomplete gate.
- more than the configured number of human-review candidates in one
  run.
- invalid value types or enums for settlement and dedupe state;
- non-empty `revisit_trigger` values on dispositions other than `revisit`.

The detector is a backstop, not a proof that prose is non-sensitive. The agent
must redact customer, commercial, personnel, personal, credential, and internal
location details before validation.

## Persistent state

The private ledger stores only:

- stable meeting key;
- source revision hash;
- meeting disposition;
- candidate ID, revision, claim hash, and disposition;
- timestamps;
- the last safely advanced discovery watermark and processed run keys;
- sanitized validated reports containing minimal excerpts.

It never stores transcript text, AI notes, provider responses, speaker maps, or
provider identity maps.

## Report-only boundary

The pilot persists candidate revision, claim hash, source revision, and
disposition for dedupe and later evaluation, but it does not persist approval
state and cannot create a publication packet.

A later phase may cross this boundary only with a server-authenticated
tracked-answer receipt that proves the exact ask, recipient, answer, selected
option, candidate revision, claim hash, and current source revision. A
caller-provided message ID, local state edit, or plain chat reply is not
approval.
