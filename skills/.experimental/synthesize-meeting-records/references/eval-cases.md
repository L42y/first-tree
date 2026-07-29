# Meeting Analysis Eval Cases

Use only synthetic artifacts. Never place live meeting content, real provider
identifiers, names, URLs, or private data in an eval fixture.

## Deterministic contract tests

Run `node scripts/test.mjs`. Cover:

1. provider documents, attachments, local files, and pasted text normalize
   through one artifact contract;
2. explicitly supplied artifacts preserve unique chronology order;
3. changing only the private artifact locator changes `source_revision`;
4. duplicate IDs or chronology indexes fail;
5. partial or unknown artifacts force `blocked-source`;
6. `no-findings` requires complete sources and zero items;
7. all six analysis categories validate;
8. AI notes alone cannot produce a confirmed item;
9. confirmed output requires matching strong evidence and completed
   later-override checks;
10. evidence references only artifact IDs in the bundle;
11. raw/private fields and values are rejected;
12. validation creates no persistent state, lock, report, or raw copy.

## Executable standalone model gate

The repository-local standalone harness installs this experimental Skill into
an isolated workspace. It does not register the Skill as a First Tree
Client/core payload and does not expose a Context Tree or downstream writer.
Run it only with explicit human instruction:

```sh
pnpm --filter @first-tree/skill-evals \
  eval:standalone:synthesize-meeting-records
```

The harness uses natural prompts that do not name the Skill. Deterministic
oracles verify that the agent reads the installed Skill, produces a packet
accepted by the real validator, preserves the six-category contract, removes
superseded material, keeps AI-only material uncertain, blocks partial input
before reading its raw artifact, does not copy synthetic raw canaries, leaves
the supplied source repository unchanged, and creates no Context Tree.

## Model-backed cases

### G1 — Six-category synthesis

Input: synthetic human-confirmed minutes containing a decision, shipped
result, future plan, concrete follow-up, temporary blocker, and material risk.

Expected: six distinct confirmed items in the matching categories; concise
context; no copied meeting prose.

### G2 — Later override and final decision

Input: two ordered synthetic artifacts. The first proposes option A. Later
human-confirmed minutes explicitly replace A with option B and state the
surviving rationale.

Expected: one decision item for B; A is absent; later-override fields are true.

### G3 — AI notes remain uncertain

Input: AI-generated notes that present a proposal, action, and risk without
human-confirmed minutes, a decision record, or an explicit transcript
statement.

Expected: `needs-confirmation`; every item is `uncertain`.

### G4 — Partial source

Input: one complete attachment plus one explicitly supplied artifact whose
reader reports incomplete extraction.

Expected: `blocked-source`; zero items; no semantic analysis.

### G5 — Logistics only

Input: complete synthetic minutes containing greetings, attendance logistics,
and a date for the next meeting but no meaningful work content.

Expected: `no-findings`; zero items.

G1 through G4 are executable in the standalone harness. G5 remains a broader
design case until it earns a deterministic oracle and fixture.

## Quality dimensions

- category recall and precision;
- later-override recall;
- confirmation accuracy;
- source-role accuracy;
- coherent item granularity;
- rationale and qualifier retention;
- no-findings correctness;
- raw/private-data escape count;
- accidental source expansion count.
