## Context Tree Policy

### What A Context Tree Is

The Context Tree is durable context, not a source-code mirror, wiki dump, or
task log. It records current decisions, constraints, ownership, and
cross-domain relationships with enough rationale that a future reader does
not have to reconstruct them from PRs, chat logs, or tribal knowledge.

### Source-System Boundary

The tree records **what was decided and why**; source repos record **how it is
implemented**. If information would rot when the next refactor lands, it does
not belong in the tree.

| Belongs in the tree | Stays in the source repo |
| --- | --- |
| A choice between alternatives and why the alternatives lost | Function signatures, types, class hierarchies |
| A constraint that shapes future implementation across repos | Step-by-step implementation walkthroughs |
| An ownership change or clarified review path | API request / response shapes |
| A current constraint that resulted from a deprecation | Test fixtures, snapshot data, build / CI config |
| A new relationship between two domains | Bug fixes that do not change a public contract |
| Rationale that would not be obvious from the diff alone | Refactors that preserve behaviour |
| A decision as it stands today: current state + present-tense rationale | Historical narrative of how we got here |

### Content Classes And Authority

- **Normal content** — root/domain `NODE.md` and regular domain leaves. It states current durable truth; when a decision changes, rewrite or remove old claims.
- **Archive/supporting content** — proposals, meetings, explorations, and raw material such as `raw-context/`. It is evidence, not canonical truth: read it only when asked, when the source is archive/proposal material, or when the task needs archive context. Normal content must not require this class.
- **Member content** — responsibility, ownership, and review scope such as `members/<id>/NODE.md`. Use it to route or validate *Who*, not as a substitute for normal decision/constraint nodes.

### Code vs Tree Drift Authority

Normal tree content is authoritative for durable context, but not a blind
override for observed source reality. By default, **code is the ground truth**
when the tree and code disagree: treat the tree as drifted and update the tree
from source-backed evidence. `decisionLocksCode: true` reverses that default
for one node: the tree wins, and code drift escalates to a human owner instead
of being silently fixed or ignored. Set or rely on that flag only on explicit
human instruction.

### The Double Test

Before writing, apply both questions to every candidate fact:

1. **Decision test.** Does this source establish or change something a future
   agent must respect when making cross-domain choices?
2. **Durability test.** If the triggering commit or PR/MR were rewritten, would
   the decision still stand?

The candidate belongs in the tree only when both answers are yes. Failing the
decision test means the source is implementation detail; failing the
durability test means the source captures how something was done this time,
not what was decided.

### Content Model: What / Why / Who

- **What** — the decision, design choice, or constraint as it stands today.
  Write the durable claim, not implementation detail or a timeline of prior
  states.
- **Why** — the surviving rationale: constraints that won, alternatives that
  lost, and design course-corrections translated into present-tense reasoning.
  Capture **why**, not only what. Design-phase chat, review, and meeting
  threads are where this rationale is produced: somebody flags a constraint,
  a first proposal is corrected, or an option conflicts with another domain.
  The node records the surviving constraint and reasoning from those moments,
  not the chronology. A node without rationale is a fact, not a decision record.
- **Who** — ownership, carried by `owners` frontmatter and
  member content. Do not put ownership in the body, and do not unilaterally
  edit `owners`.

### Add vs Edit

Default to editing an existing node. A node earns its existence by being
independently findable, ownable, or linkable; otherwise edit the existing
node. Add a leaf only when all three hold:

1. **Distinct identity** — a noun-phrase title that does not overlap any
   sibling.
2. **Distinct anchor** — at least one of: different `owners`; another domain
   would `soft_links` to this specific decision; or the source naturally has
   its own Decision / Rationale / Constraints that cannot co-live with an
   existing leaf.
3. **Passes the Double Test.**

Add a directory only when at least three cohesive leaves share an axis. New
top-level domains require explicit human-owner approval. When a decision
touches two domains, keep canonical content in the more specific domain and
link from the broader one with normal-to-normal `soft_links` or short prose.

### Node Shape

Required frontmatter:

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

Useful optional frontmatter: `description`, `soft_links`,
`lastReviewed`, and `decisionLocksCode`. `lastReviewed` records an actual
owner review; update it only through that review/audit workflow, never during
a source-backed write. Use `owners: ["*"]` only when a human explicitly opens
ownership to everyone. Metadata supports scanning, routing, and responsibility.

Prefer body sections in this order, omitting any that do not apply:
`Decision`, `Rationale`, `Constraints`, `Cross-Domain`. There is no
`Source`, `Provenance`, or `Shipped-in` section; PR/MR / commit / issue
delivery history lives in git history and PR/MR descriptions, not node prose.

### Write / Verify / PR/MR Discipline

Default to not writing: a missing node is a question, a noisy node is a trap.
Source-backed writes require a concrete source artifact and surrounding context
(source, target, parent, relevant `soft_links`, ownership-adjacent member
content) unless already known. Actionable future work does not live in normal
tree content; put it in an issue, source artifact, or human decision instead.
The active First Tree channel's `tree verify` command must pass before any tree
commit. Keep tree prose current-state: no timeline, provenance, PR/MR references,
or implementation detail. A source-backed tree PR/MR should stay scoped to one
source artifact so owner review and rollback stay precise.
