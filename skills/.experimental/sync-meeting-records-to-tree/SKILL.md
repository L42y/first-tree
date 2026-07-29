---
name: sync-meeting-records-to-tree
description: Turn exact meeting records that the user supplies into confirmed, durable Context Tree updates. Use when a user asks to sync meeting minutes, transcripts, AI notes, decision records, or related meeting artifacts into the team's Context Tree: read the exact sources, reconcile chronology, identify participants, map them to First Tree members, extract decisions, progress, plans, actions, blockers, and risks, confirm relevant points with those members, keep the raw transcript locally, and hand the confirmed source material to first-tree-write. Do not use for a summary-only request, calendar discovery, meeting search, provider authorization, or scheduled capture.
---

# Sync Meeting Records to the Context Tree

Turn one logical meeting's exact source artifacts into reviewable Context Tree
updates. Use existing readers, First Tree member communication, and
`first-tree-write`; do not build a parallel reader, confirmation store, or Tree
writer.

## Establish the meeting source

- Require at least one concrete meeting artifact and clear intent to update the
  Context Tree. If either is missing, ask for it and stop.
- Process one logical meeting at a time. When supplied artifacts may belong to
  different meetings, separate them using explicit source evidence or ask the
  user to group them.
- Use the environment's ordinary reader for each exact provider document,
  attachment, local file, or pasted record. For a Feishu source, use the
  available Feishu reader or CLI; keep provider authorization, download, OCR,
  parsing, completeness, and revision handling in that reader layer.
- Do not use a calendar, search for related meetings, scan a time window, or
  follow links embedded in a source to discover adjacent material.
- Preserve the user-declared or document-visible order. If order is unknown,
  do not infer that one artifact overrides another.
- If an artifact is unreadable or incomplete, identify the gap. When the gap
  could contain a correction or later decision, do not call the affected point
  settled.
- Keep any supplied raw transcript as a local task artifact and report where
  it is retained. Never commit the raw transcript to the Context Tree or a
  source repository.

## Reconcile the meeting record

Read the available artifacts in order and extract:

- `decision` — a choice, agreement, or explicit non-choice;
- `progress` — a meaningful result or state reached;
- `plan` — intended future work or direction;
- `action` — a concrete follow-up, with owner or timing when stated;
- `blocker` — an impediment that needs resolution;
- `risk` — a material uncertainty or downside.

For every candidate:

1. Separate proposals, discussion, and final statements.
2. Scan all later material for correction, withdrawal, replacement,
   disagreement, completion, or cancellation.
3. Keep only the surviving current statement.
4. Preserve relevant rationale, qualifiers, and consequences.
5. Attribute member-specific progress, plans, actions, blockers, and risks only
   when the source supports that attribution.
6. Keep meeting-level decisions and shared constraints separate from
   member-specific updates.
7. Distinguish supported conclusions from uncertain interpretations.

Evidence strength matters:

- Human-confirmed minutes or an explicit decision record may confirm an item
  when wording is unambiguous and no later material overrides it.
- AI-generated notes may identify an item but cannot alone prove human
  confirmation.
- A transcript confirms only what it explicitly records. Do not infer speaker
  identity, authority, or agreement from participation.
- When provenance or wording is ambiguous, state the uncertainty instead of
  promoting it to a fact.

## Match and confirm members

- Identify participants only from the supplied meeting record. Match them to
  First Tree members using the member context available in the current
  environment. Do not guess when names or identities are ambiguous; leave the
  mapping unresolved and ask the user or relevant member.
- Treat member mapping as routing information, not permission to change Context
  Tree ownership.
- Send each matched member a concise confirmation request containing only the
  points attributed to them or requiring their decision. Use the runtime's
  tracked question mechanism when the Tree write depends on the answer.
- Apply corrections from confirmations before writing. Keep disputed,
  unanswered, or ambiguously attributed points out of normal Tree content;
  report them as unresolved instead.
- If the current environment cannot contact the relevant members, return the
  prepared confirmation prompts and stop before the Tree write.

## Sync durable context

- Treat the exact meeting artifacts, relevant confirmation replies, and the
  user's Tree-write intent as one meeting source bundle for `first-tree-write`.
  Do not reimplement its Tree-read, target-selection, verification, branch, or
  PR workflow.
- Let `first-tree-write` apply the Context Tree Double Test. Sync only durable
  decisions, constraints, ownership or responsibility changes confirmed by the
  affected humans, and cross-domain relationships that future agents must
  respect.
- Do not dump the transcript, the complete meeting summary, routine progress,
  temporary plans, task lists, or transient blockers into normal Tree content.
  Those remain in their source systems unless they establish durable context.
- If nothing passes the Tree write bar, create no Tree change and explain why.
- Let `first-tree-write` verify the Tree and prepare the Tree PR or MR. Stop
  before review or merge.

## Finish

Report:

- the meeting artifacts processed and the local transcript location;
- participant-to-member matches and unresolved identities;
- confirmed, corrected, disputed, and unanswered points;
- the Context Tree nodes changed and the Tree PR or MR, or why no Tree write
  was warranted.

Never maintain discovery watermarks, processed ledgers, provider profiles,
organizer gates, schedules, or a parallel approval state.
