# Meeting Analysis Contracts

## Contents

- Reader boundary
- Artifact bundle
- Meeting-analysis packet
- Status rules

## Reader boundary

The user supplies the complete task scope. A reader may resolve only the
provided provider document, attachment, local path, pasted text, or explicitly
ordered bundle. It must not discover adjacent meetings, follow embedded links,
or add provider sources automatically.

Provider authorization, transport, conversion, OCR, and file parsing stay with
the reader or platform. This skill receives readable content plus minimal
task-local metadata; it never owns credentials, calendars, organizer checks,
schedules, or provider state.

## Artifact bundle

Keep raw content in the source system, conversation context, or a task-local
temporary file. Reference it from the bundle; do not inline it.

```json
{
  "schema": "synthesize-meeting-records.artifact-bundle.v1",
  "meeting_scope": "single-meeting",
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

`input_kind` is `provider_link`, `attachment`, `local_file`, or
`pasted_text`.

`source_role` is `human_minutes`, `ai_notes`, `transcript`,
`decision_record`, or `unknown`.

`content_ref.kind` is `conversation` or `task_file`. Its locator is private,
task-local routing data and must not appear in the output packet.

`completeness` is `complete`, `partial`, or `unknown`. Any non-complete
artifact blocks semantic analysis.

Use the provider's document revision when available; otherwise use a content
SHA-256. The preparation script hashes each complete `content_ref` and includes
only that privacy-safe digest, alongside declared revision and artifact
metadata, in the bundle-level `source_revision`. Changing only the supplied
document, attachment, local file, or pasted-text reference changes the packet
binding without exposing its URL or path.

## Meeting-analysis packet

```json
{
  "schema": "synthesize-meeting-records.meeting-analysis-packet.v1",
  "source_revision": "<64 lowercase hex characters>",
  "status": "complete",
  "reason": "The supplied minutes establish one decision and one action.",
  "items": [
    {
      "category": "decision",
      "statement": "Use a provider-neutral artifact contract for meeting analysis.",
      "context": "The contract keeps reading separate from analysis and downstream publication.",
      "attribution": "Meeting participants",
      "settlement": {
        "status": "confirmed",
        "basis": "human_confirmed_minutes"
      },
      "chronology": {
        "later_override_checked": true,
        "overridden_items_excluded": true
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

`category` is `decision`, `progress`, `plan`, `action`, `blocker`, or `risk`.

`attribution` is optional. Include only the minimum role or person label needed
to make an action or update useful. Never include provider IDs, contact
details, or a participant roster.

Settlement basis is:

- `human_confirmed_minutes`
- `explicit_decision_record`
- `transcript_explicit_human_statement`
- `ai_generated_summary`
- `unknown`

Do not include raw excerpts. `location_hint` is a structural locator such as
`Decision section` or `final paragraph`, not copied source text.

## Status rules

`blocked-source` requires at least one `partial` or `unknown` artifact and zero
items.

`no-findings` requires complete sources and zero items.

`needs-confirmation` requires complete sources, at least one item, and at least
one item whose settlement status is `uncertain`.

`complete` requires:

- every artifact is complete;
- at least one item exists;
- every item is `confirmed`;
- every confirmed item uses a strong basis;
- cited evidence includes the source role matching that basis:
  `human_minutes`, `decision_record`, or `transcript`;
- later override was checked and overridden items were excluded;
- evidence references only artifact IDs in the bundle.

The packet has no destination, handoff, target, dedupe, write, or publication
field.

Reject raw/private keys and values, including transcript bodies, excerpts,
URLs, provider IDs, tokens, credentials, absolute paths, contact details,
secret shapes, and exact currency amounts. Minimize personal attribution even
when it is not machine-detectable.
