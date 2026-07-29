---
name: synthesize-meeting-records
description: Synthesize meeting records and related artifacts that the user explicitly supplies, including provider documents, uploaded attachments, local files, pasted text, human minutes, AI notes, transcripts, and decision records. Use to extract decisions, progress, plans, action items, blockers, and risks; reconcile chronology and later corrections; distinguish supported conclusions from uncertainty; and produce a destination-neutral meeting analysis. Do not use for calendar discovery, meeting search, provider authorization, scheduled capture, raw archiving, or publishing analysis to downstream systems.
---

# Synthesize Meeting Records

Synthesize the exact meeting artifacts supplied by the user into a concise
account of what the meeting established. Do not choose or mutate a downstream
destination.

## Use only the supplied artifacts

- Use the environment's ordinary reader for each exact provider document,
  attachment, local file, or pasted record the user supplied.
- Keep authorization, download, conversion, OCR, parsing, completeness, and
  revision handling in that reader layer.
- Do not use a calendar, search for related meetings, infer an organizer, scan
  a time window, or follow links embedded in the source.
- If an artifact is unreadable or incomplete, identify that gap instead of
  widening the source scope or inventing missing content.
- Preserve the user-declared or document-visible order so later material can
  correct earlier material.

## Analyze the full chronology

Read the available artifacts in order. Extract useful items in these
categories:

- `decision` — a choice, agreement, or explicit non-choice;
- `progress` — a meaningful result or state reached;
- `plan` — intended future work or direction;
- `action` — a concrete follow-up, optionally with necessary attribution;
- `blocker` — an impediment that needs resolution;
- `risk` — a material uncertainty or downside.

For each possible item:

1. Separate proposals, discussion, and final statements.
2. Scan all later material for correction, withdrawal, replacement,
   disagreement, completion, or cancellation.
3. Keep only the surviving current statement.
4. Preserve relevant rationale, qualifiers, and consequences.
5. Distinguish conclusions supported by the records from uncertain
   interpretations.
6. Produce one item per coherent subject; do not collapse unrelated decisions,
   actions, or risks.

Evidence strength matters:

- Human-confirmed minutes or an explicit decision record may confirm an item
  when wording is unambiguous and no later material overrides it.
- AI-generated notes may identify an item but cannot alone prove human
  confirmation.
- A transcript confirms only what it explicitly records. Do not infer speaker
  identity, authority, or agreement from participation.
- When provenance or wording is ambiguous, state the uncertainty instead of
  promoting it to a fact.

## Return analysis only

Return a concise, destination-neutral analysis organized around the six
categories. Include the rationale, attribution, or source cue that is useful
for understanding an item. Clearly separate supported conclusions,
uncertainties, and missing-source limitations. If nothing material was
established, say so.

Do not publish to a downstream system, project document, or source repository.
Do not create branches, pull requests, tracked asks, schedules, or durable
processing state. A caller may independently choose a confirmation or
publication workflow after this skill finishes.

## Preserve hard boundaries

- Never maintain discovery watermarks, processed ledgers, provider profiles,
  organizer gates, persistent reports, locks, schedules, or approval state.
- Never treat the user supplying a readable artifact as permission to discover
  adjacent material.
- Never apply destination-specific durability, dedupe, targeting, writing,
  verification, or publication rules.
