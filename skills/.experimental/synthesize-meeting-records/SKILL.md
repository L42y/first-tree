---
name: synthesize-meeting-records
description: Synthesize meeting records and related artifacts that the user explicitly supplies, including provider documents, uploaded attachments, local files, pasted text, human minutes, AI notes, transcripts, and decision records. Use to extract decisions, progress, plans, action items, blockers, and risks; reconcile chronology and later overrides; distinguish confirmed from uncertain material; and produce a sanitized, destination-neutral meeting analysis. Do not use for calendar discovery, meeting search, provider authorization, scheduled capture, raw archiving, or publishing analysis to downstream systems.
---

# Synthesize Meeting Records

Synthesize exact meeting artifacts supplied by the user into a concise,
sanitized account of what the meeting established without choosing or
mutating any downstream destination.

## Keep reading outside the skill

- Accept only artifacts the user explicitly supplies in the current task:
  provider documents, attachments, local files, pasted text, or an explicitly
  ordered bundle for one logical meeting.
- Use the environment's ordinary provider or file reader to resolve each exact
  artifact. Keep OAuth, access control, download, conversion, OCR, and file
  parsing in that reader layer.
- Do not use a calendar, search for related meetings, infer an organizer, scan
  a time window, or follow links embedded in the source.
- If an exact artifact cannot be read, ask for an export, attachment, local
  file, or pasted text. Do not widen the source scope.
- Preserve provider revisions, extraction completeness, source roles, and the
  user-declared or document-visible order.

## Normalize one task-local bundle

Create a task-local JSON file following
[contracts.md](references/contracts.md). Store metadata and a temporary content
reference; never inline raw meeting text in the bundle.

Run:

```sh
node scripts/prepare-artifacts.mjs --bundle <meeting-artifact-bundle.json>
```

The command validates the source boundary and returns an exact
`source_revision`. It does not open, copy, or persist artifact content.

Classify every artifact as:

- `human_minutes`
- `ai_notes`
- `transcript`
- `decision_record`
- `unknown`

Take `completeness` from the reader result. Do not infer `complete` merely
because some text was returned. If any supplied artifact is `partial` or
`unknown`, or if any `source_role` is `unknown`, emit `blocked-source` without
semantic analysis.

Keep the bundle and raw content task-local. Clean temporary copies through the
reader's normal cleanup path as soon as they are no longer needed.

## Analyze the full chronology

Read every complete artifact in chronology order. Extract independently useful
items in these categories:

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
4. Preserve relevant rationale, qualifiers, and consequences without copying
   meeting prose.
5. Mark the item `confirmed` only when its cited evidence supports the claimed
   basis.
6. Mark AI-note-only or ambiguous material `uncertain`.
7. Produce one item per coherent subject; do not collapse unrelated decisions,
   actions, or risks.

Evidence strength matters:

- Human-confirmed minutes or an explicit decision record may confirm an item
  when wording is unambiguous and no later material overrides it.
- AI-generated notes may identify an item but cannot alone prove human
  confirmation.
- A transcript confirms only what it explicitly records. Do not infer speaker
  identity, authority, or agreement from participation.
- Unknown provenance requires `blocked-source`. Ambiguous wording in a
  complete artifact with known provenance produces an `uncertain` item.

## Produce a destination-neutral packet

Write one task-local packet following
[meeting-analysis-packet.schema.json](references/meeting-analysis-packet.schema.json).
Use exactly one status:

- `complete` — complete sources yield at least one confirmed item and no
  uncertain item;
- `needs-confirmation` — complete sources yield at least one uncertain item;
- `no-findings` — complete sources contain no decision, progress, plan,
  action, blocker, or risk worth reporting;
- `blocked-source` — at least one supplied artifact is incomplete or cannot be
  classified safely.

The packet contains concise statements and minimal artifact/location
references. Do not include raw excerpts, URLs, provider identifiers, document
tokens, file paths, credentials, copied meeting prose, unnecessary personal
details, or exact sensitive amounts.

Validate it:

```sh
node scripts/validate-output.mjs \
  --bundle <meeting-artifact-bundle.json> \
  --output <meeting-analysis-packet.json>
```

Validation binds the packet to the exact source revision, rejects raw/private
shapes, and enforces source-strength and chronology gates. A passing validator
is a backstop, not proof that prose is safe; minimize and redact first.

## Return analysis only

Return a concise sanitized summary and the validated packet or its task-local
path. State clearly when the result is `needs-confirmation`,
`no-findings`, or `blocked-source`.

Do not publish to a downstream system, project document, or source repository.
Do not create branches, pull requests, tracked asks, scheduled jobs, or durable
processing state. A caller may choose a downstream workflow after this skill
finishes; that orchestration is outside this skill.

## Preserve hard boundaries

- Never archive raw meeting material in a source repository, packet, PR body,
  or ordinary chat response.
- Never maintain discovery watermarks, processed ledgers, provider profiles,
  organizer gates, persistent reports, locks, schedules, or approval state.
- Never treat the user supplying a readable artifact as permission to discover
  adjacent material.
- Never apply destination-specific durability, dedupe, targeting, writing,
  verification, or publication rules.
- Treat `no-findings` as a successful result.

## Validate skill changes

Run:

```sh
node skills/.experimental/synthesize-meeting-records/scripts/test.mjs
python3 scripts/quick_validate_skill.py skills/.experimental/synthesize-meeting-records
```

Use [eval-cases.md](references/eval-cases.md) as the model-behavior test design.
Its repository-local standalone harness is executable but remains
human-directed. Do not run model-backed evaluation without explicit human
instruction.
