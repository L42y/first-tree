---
name: return-meeting-context
description: Extract settled durable decisions, constraints, and rationale from meeting artifacts that the user explicitly supplies, including provider document links, uploaded attachments, local files, and pasted text. Use when a user asks to analyze meeting minutes, AI notes, transcripts, or decision records for reusable context, or asks to reflect such material into a Context Tree. Resolve only the supplied artifacts, keep raw content outside persistent output, produce a sanitized decision-evidence packet, and hand eligible claims to first-tree-write. Do not use for calendar discovery, meeting search, raw archiving, progress summaries, action-item tracking, provider authorization, scheduled capture, or direct Tree review or merge.
---

# Return Meeting Context

Turn user-supplied meeting artifacts into a small, sanitized set of durable
claims. Treat every artifact as evidence, never as approved organizational
truth.

## Keep acquisition outside the skill

- Accept only artifacts the user explicitly provides in the current task:
  provider document links, attachments, local paths, or pasted text.
- Use the environment's ordinary provider or file reader for that exact
  artifact. Provider login, OAuth, access control, and attachment transport
  belong to the reader or platform, not this skill.
- Do not use a calendar, search for related meetings, infer an organizer, scan
  a time window, or follow links embedded in the source.
- If the exact artifact cannot be read, ask for an export, attachment, local
  file, or pasted text. Do not widen the source scope.
- Allow multiple artifacts only when the user explicitly supplies them as one
  logical meeting bundle. Preserve their declared or document-visible order.

## Normalize one task-local artifact bundle

Create a task-local JSON file following
[contracts.md](references/contracts.md). Record only metadata and a temporary
content reference; never inline raw content in the bundle.

Use:

```sh
node scripts/prepare-artifacts.mjs --bundle <meeting-artifact-bundle.json>
```

The command validates the source boundary and returns the exact
`source_revision`. It does not open, copy, or persist artifact content.

Classify each artifact as one of:

- `human_minutes`
- `ai_notes`
- `transcript`
- `decision_record`
- `unknown`

Mark `completeness` from the reader result. Do not infer `complete` merely
because some text was returned. A partial or unknown artifact makes the bundle
`blocked-source`; do not analyze it or claim `no-change`.

Keep the bundle and raw content task-local. Delete temporary copies through the
reader's normal cleanup path as soon as the task no longer needs them.

## Analyze the full supplied chronology

Read every complete artifact in chronology order.

For every possible claim:

1. Separate proposals, discussion, and final conclusions.
2. Scan later material for correction, withdrawal, replacement, disagreement,
   or an unresolved question.
3. Keep only the surviving current-state claim.
4. Apply the Context Tree Decision Test and Durability Test.
5. Preserve `What`, `Why`, and implementation-independent `Constraints`.
6. Exclude progress, tasks, owners' status updates, logistics, schedules,
   temporary blockers, and unresolved plans.
7. Produce one candidate per coherent durable decision.

Evidence strength matters:

- Human-confirmed minutes or an explicit decision record may establish
  settlement when the wording is unambiguous and no later material overrides
  it.
- AI-generated notes may identify a candidate but cannot alone prove human
  settlement.
- A transcript proves what was said. It establishes settlement only when the
  supplied chronology contains an explicit final human choice or confirmation.
- Unknown provenance or ambiguous language requires claim-level confirmation.

Do not guess speaker identity, participant authority, or missing chronology.

## Produce a sanitized decision-evidence packet

Write one task-local packet following
[decision-evidence-packet.schema.json](references/decision-evidence-packet.schema.json).
Use exactly one packet status:

- `no-change` — complete sources contain no durable claim;
- `needs-confirmation` — at least one plausible claim lacks settlement;
- `ready-for-write` — every candidate is settled, durable, and survives later
  override checks;
- `blocked-source` — at least one supplied artifact is incomplete or cannot be
  classified safely.

The packet contains claims and minimal artifact/location references only. It
must not contain raw excerpts, URLs, provider IDs, participant or speaker
identifiers, document tokens, file paths, credentials, customer or personnel
details, exact commercial amounts, or copied meeting prose.

Validate it:

```sh
node scripts/validate-output.mjs \
  --bundle <meeting-artifact-bundle.json> \
  --output <decision-evidence-packet.json>
```

Validation binds the packet to the exact source revision, rejects raw/private
shapes, and enforces settlement and chronology gates. A passing validator is a
backstop, not proof that prose is safe; minimize and redact before validation.

## Route by the user's intent

If the user asked only for analysis, return a concise sanitized summary of the
packet. Do not create a Tree branch or PR.

If the user asked to reflect the meeting into the Context Tree:

- For `ready-for-write`, load `first-tree-write` and use the supplied source
  artifact plus the validated packet as its source context. Let
  `first-tree-write` own current Tree and open-proposal dedupe, target
  selection, current-state rewriting, verification, branch/PR preparation,
  and provider follow.
- For `needs-confirmation`, ask one focused question about the exact durable
  claim. Re-read or re-hash the supplied source before continuing if it can
  change. After confirmation, regenerate and revalidate the packet.
- For `no-change` or `blocked-source`, stop without calling
  `first-tree-write`.

The Tree PR is a proposal, not active truth. Review and merge remain outside
this skill.

## Preserve hard boundaries

- Never archive raw meeting material in the Context Tree, source repo, packet,
  PR body, or ordinary chat response.
- Never maintain meeting discovery watermarks, processed ledgers, provider
  profiles, organizer gates, persistent reports, locks, schedules, or approval
  state.
- Never create a tracked ask merely to authorize reading an artifact the user
  already supplied. Ask only when the semantic claim itself needs confirmation.
- Never duplicate `first-tree-write` target, edit, verification, or PR logic.
- Treat valid `no-change` as a successful outcome.

## Validate skill changes

Run:

```sh
node skills/return-meeting-context/scripts/test.mjs
python3 scripts/quick_validate_skill.py skills/return-meeting-context
pnpm --filter @first-tree/skill-evals eval:floor -- --suite return-meeting-context
```

Use [eval-cases.md](references/eval-cases.md) for model-backed gate cases.
Those gates require explicit human instruction to run.
