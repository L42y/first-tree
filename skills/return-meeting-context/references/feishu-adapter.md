# Feishu Adapter Boundary

The bundled collector implements only response paths validated against
sanitized first-hand evidence from `lark-cli` 1.0.39 and re-records the actual
installed CLI version in each run.

## Required behavior

1. Resolve the immutable self identity from the member's local user credential
   and require it to match the configured owner before discovery.
2. Discover by calendar/document metadata, not title date strings.
3. Require exact organizer/owner identity before fetching raw content.
4. Use stable calendar instance and meeting/document IDs.
5. Follow multiple safe source paths because VC recording, minutes search, and
   document association can disagree or return partial results.
6. Assemble all segments by provider timestamps and stable segment IDs.
7. Record provider revision when available and always include content hashes in
   the normalized source revision.
8. Mark missing or conflicting paths as `partial`; never infer completeness.
9. Keep every provider response and artifact beneath the run-lifetime private
   temp directory with mode `0600`.
10. Delete the temp directory on finalize or abort.

## Implemented read-only CLI surfaces

Inspect local `--help` and schemas before every adapter change. The observed
surfaces include:

```sh
lark-cli calendar +agenda
lark-cli vc +notes
lark-cli docs +fetch
lark-cli api GET /open-apis/authen/v1/user_info
```

Do not codify response fields from memory. Do not use `--overwrite` outside the
run temp directory. Do not fall back from owner-scoped calendar evidence to a
participant-visible meeting without a matching organizer.

## Current fallback posture

Treat this as routing guidance, not a fixed field contract:

1. The authenticated-user endpoint binds the local CLI profile to the
   configured immutable owner identity. Failure or mismatch stops before
   calendar discovery.
2. `calendar +agenda` supplies occurrence identity, organizer, and bounded
   discovery. Do not pass generic `lark-cli api` pagination flags to this
   helper. The official 1.0.39 implementation recursively splits windows over
   40 days and provider range-limit responses, then combines, deduplicates, and
   sorts the resulting occurrences. This helper-owned completeness behavior is
   the basis for `discovery_complete`; if the installed helper's behavior
   cannot be verified, fail closed. See
   [`calendar_agenda.go`](https://github.com/larksuite/cli/blob/v1.0.39/shortcuts/calendar/calendar_agenda.go).
3. Apply the organizer owner gate before fetching meeting notes or documents.
4. `vc +notes --calendar-event-ids` supplies the verified
   calendar→meeting→transcript-token lineage.
5. Require non-empty exact `calendar_event_id`, `meeting_id`, and
   `verbatim_doc_token` fields before fetching raw content. Duplicate or
   conflicting tokens/documents make the source partial.
6. `docs +fetch --api-version v2` supplies document revision and content.
7. If v2 is unavailable, paginated v1 is accepted only when every page is
   contiguous and complete; exact content SHA-256 replaces provider revision.

Observed `vc +recording` item errors do not override a successful notes path.
Observed empty `minutes +search` results cannot establish absence. VC/docs
search remain future discovery supplements because the observed response shape
does not by itself prove a unique calendar occurrence binding. If the
implemented path cannot establish complete chronology, return `partial` /
`blocked-source`. The deterministic preparation step keeps that meeting
metadata-only, does not open its raw segment files, and does not expose it to
semantic analysis.

## Observed field contract

- Calendar occurrence: `data[].event_id`
- Calendar organizer: `data[].event_organizer.user_id`
- Authenticated profile owner: `data.open_id` (or the equivalent nested
  provider response returned by the generic API helper)
- Calendar time: `data[].start_time.datetime` /
  `data[].end_time.datetime`
- Note lineage: `data.notes[].calendar_event_id`,
  `meeting_id`, and `verbatim_doc_token`
- V2 document: `data.document.document_id`, `revision_id`, and `content`
- V1 page: `data.doc_id`, `markdown`, `offset`, `length`, and `total_length`

`creator_id` is the note creator, not the meeting owner.
`recurring_event_id` is a series hint, not an occurrence key.
