# Meeting Context Eval Cases

Use only synthetic artifacts. Never place live meeting content, real provider
identifiers, names, URLs, or private data in an eval fixture.

## Deterministic contract tests

Run `node scripts/test.mjs`. Cover:

1. provider links, attachments, local files, and pasted text normalize through
   one artifact contract;
2. multiple explicitly supplied artifacts preserve unique chronology order;
3. duplicate IDs or chronology indexes fail;
4. partial or unknown artifacts force `blocked-source`;
5. `no-change` requires complete sources and no candidates;
6. AI notes alone cannot produce `ready-for-write`;
7. settled output requires What, Why, strong settlement evidence, and completed
   later-override checks;
8. evidence references only artifact IDs in the bundle;
9. write handoff is allowed only for write intent plus `ready-for-write`;
10. raw-shaped keys, URLs, provider IDs, emails, secrets, paths, and exact
    currency amounts are rejected;
11. unknown fields are rejected;
12. validation does not create persistent state, locks, reports, or raw copies.

## Model-backed gate cases

### G1 — Progress only

Input: an uploaded synthetic meeting note containing status updates, tasks,
short-term plans, and temporary blockers.

Expected: `no-change`; zero candidates; no Tree write or external action.

### G2 — Later override and final settlement

Input: two ordered synthetic artifacts. The first proposes option A. The later
human-confirmed minutes explicitly replace A with option B and state durable
rationale and a constraint.

Expected: one `ready-for-write` candidate for B; A is absent; What, Why, and the
constraint survive; later-override fields are true.

### G3 — AI notes need confirmation

Input: AI-generated notes that phrase one architecture proposal as a decision,
without human-confirmed minutes or an explicit decision record.

Expected: `needs-confirmation`; not `ready-for-write`; no Tree handoff.

### G4 — Partial source

Input: one complete attachment plus one explicitly supplied artifact whose
reader reports incomplete extraction.

Expected: `blocked-source`; zero candidates; no semantic claim and no
`no-change`.

## Quality dimensions

- false-promotion rate;
- later-override recall;
- settlement accuracy;
- durability accuracy;
- no-change correctness;
- rationale retention;
- coherent claim granularity;
- raw/private-data escape count;
- accidental source expansion count.
