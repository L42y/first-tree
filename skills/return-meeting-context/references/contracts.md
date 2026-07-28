# Meeting Artifact Contracts

## Contents

- Acquisition boundary
- Artifact bundle
- Decision-evidence packet
- Status and handoff rules

## Acquisition boundary

The user supplies the complete task scope. A reader may resolve only the
provided link, attachment, local path, pasted text, or explicitly supplied
bundle. It must not discover adjacent meetings, follow embedded links, or add
provider sources automatically.

Provider authorization and file transport stay with the reader or platform.
This skill receives content plus minimal task-local metadata; it never owns
credentials, grants, calendars, organizer checks, schedules, or provider
state.

## Artifact bundle

Store raw content in the source system, conversation context, or a task-local
temporary file. The bundle references that content but never inlines it.

```json
{
  "schema": "return-meeting-context.artifact-bundle.v1",
  "meeting_scope": "single-meeting",
  "requested_intent": "write",
  "artifacts": [
    {
      "artifact_id": "minutes",
      "input_kind": "provider_link",
      "media_type": "text/markdown",
      "source_role": "human_minutes",
      "revision": "provider-revision-or-content-sha256",
      "completeness": "complete",
      "chronology_index": 0,
      "content_ref": {
        "kind": "conversation",
        "locator": "current-user-supplied-document"
      },
      "extraction_warnings": []
    }
  ]
}
```

`input_kind` is one of:

- `provider_link`
- `attachment`
- `local_file`
- `pasted_text`

`source_role` is one of:

- `human_minutes`
- `ai_notes`
- `transcript`
- `decision_record`
- `unknown`

`content_ref.kind` is `conversation` or `task_file`. The locator is private,
task-local routing data and must not be copied into the output packet.

`completeness` is `complete`, `partial`, or `unknown`. Any non-complete
artifact blocks semantic analysis.

`revision` uses the provider's document revision when available; otherwise use
a content SHA-256. The preparation script hashes each `content_ref` separately
and includes only that privacy-safe digest, alongside the declared revision and
artifact metadata, in the bundle-level `source_revision`. Changing the supplied
document, attachment, local file, or pasted-text reference therefore changes
the packet binding without exposing its URL or path.

## Decision-evidence packet

```json
{
  "schema": "return-meeting-context.decision-evidence-packet.v1",
  "source_revision": "<64 lowercase hex characters>",
  "status": "ready-for-write",
  "reason": "One settled durable policy survives the supplied chronology.",
  "handoff": "first-tree-write",
  "candidates": [
    {
      "claim": {
        "what": "Meeting context ingestion starts from artifacts the user explicitly supplies.",
        "why": "An explicit artifact boundary is portable across providers and avoids hidden discovery.",
        "constraints": [
          "Raw meeting content remains outside persistent output."
        ]
      },
      "settlement": {
        "status": "settled",
        "basis": "human_confirmed_minutes"
      },
      "chronology": {
        "later_override_checked": true,
        "overridden_claims_excluded": true
      },
      "evidence": [
        {
          "artifact_id": "minutes",
          "location_hint": "Decision section"
        }
      ]
    }
  ]
}
```

Packet status is one of:

- `no-change`
- `needs-confirmation`
- `ready-for-write`
- `blocked-source`

Settlement basis is one of:

- `human_confirmed_minutes`
- `explicit_decision_record`
- `transcript_explicit_human_choice`
- `ai_generated_summary`
- `unknown`

Do not include raw excerpts. `location_hint` is a short structural locator such
as `Decision section` or `final paragraph`, not copied source text.

## Status and handoff rules

`no-change` requires complete sources and zero candidates.

`blocked-source` requires at least one `partial` or `unknown` artifact and zero
candidates. It is not interchangeable with `no-change`.

`needs-confirmation` requires at least one candidate whose settlement status is
`uncertain`; `handoff` remains `none`.

`ready-for-write` requires:

- every artifact is complete;
- every candidate has What and Why;
- every candidate is settled;
- every candidate uses a strong settlement basis;
- the cited evidence includes the matching source role for that basis:
  `human_minutes`, `decision_record`, or `transcript`;
- later override was checked and overridden claims were excluded;
- evidence references only artifact IDs in the bundle;
- `handoff` is `first-tree-write` only when `requested_intent` is `write`.

The packet never carries Tree target or dedupe results.
`first-tree-write` owns current Tree/open-PR dedupe, target selection, drafting,
verification, and PR preparation.

Reject raw/private keys and values, including transcript bodies, excerpts,
URLs, provider IDs, participant or speaker identifiers, tokens, credentials,
absolute paths, email addresses, secret shapes, and exact currency amounts.
