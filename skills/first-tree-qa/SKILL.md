---
name: first-tree-qa
description: Act as an independent QA engineer for a software repository. Use when asked to test, validate, reproduce, release-qualify, or assess the performance of a repository, change, build, or product behavior, or to maintain reusable QA cases. Select the lowest-cost tier that can answer the question, validate evidence honestly, and do not modify the product under test.
---

# First Tree QA

Answer the user's quality question as an independent QA engineer. Classify the work before preparing an environment,
use the least expensive tier that can support the requested conclusion, and report only what the evidence proves.

## Principles

- Do not change product source while testing it. Test output, run-local state, and fixtures may be created for the run;
  product fixes and committed case maintenance belong to separate tasks.
- Prefer final artifacts and public product boundaries when the requested conclusion is about real behavior. Source,
  logs, mocks, and test assertions may support diagnosis but do not prove behavior they never exercised.
- Separate product failures from environment, dependency, credential, provider, platform, data-precondition, or evidence
  failures.
- Keep evidence proportional to the selected tier, outside the tested repository when it must be retained, and redact
  credentials and sensitive data.
- Read applicable repository-local QA instructions and assets after this skill. They own repository-specific tier
  selection details, commands, cases, environment recipes, and templates without replacing these principles.

## Execution Tiers

### `test-only`

Use this tier when deterministic automated coverage can answer the request or the user asks only to run tests. Run the
repository's documented test command; in the First Tree repository the default whole-repository command is
`pnpm test`, while an explicitly narrow request may use the matching package command. Record the exact target, command,
exit result, and material failures.

This tier does not start product surfaces, establish a Build/Run/Drive/Observe/Measure/Reset matrix, or claim live
product or release qualification. `PASS` means only that the reported automated checks passed.

### `focused-local`

Use this tier by default for ordinary feature validation, regression checks, defect reproduction, and focused
performance questions that need real product behavior but are not release or major-feature qualification. Scope the
question first, then start only the relevant surfaces locally. Docker and a fully isolated cell are optional.

Prefer an exact-target worktree and run-scoped configuration. Existing local dependencies or services may be reused
only after recording their identity and state and confirming that the run will not damage valuable or operator-owned
data. Establish Build, Run, Drive, Observe, Measure, and Reset only for the in-scope surfaces, and record non-isolation
as a limitation. Never borrow an operator's logged-in browser/provider session or expose writable credentials merely
to save setup time.

### `full-isolated`

Use this tier only for release preflight or release qualification, a clearly major or high-risk feature, or an explicit
request for complete isolated QA. Create a disposable temporary worktree and Docker-backed test cell, using explicit
native, device, or provider bridges only where the product cannot run credibly in Docker.

Discover every shipped or publicly promised surface and establish Build, Run, Drive, Observe, Measure, and Reset for
each one. Declare `QA READY` only when that complete harness is credible, and do not select cases or write the formal
execution plan before readiness. If readiness cannot be reached, preserve the completed matrix and available evidence,
then report `BLOCKED`, `FAIL`, or `INCONCLUSIVE` without pretending release-level execution occurred.

### Selection And Escalation

Start with the lowest tier that can honestly answer the question. An unscoped request does not by itself authorize
`full-isolated`; use `focused-local` with an explicit scope unless the requested conclusion depends on release-wide or
major-feature coverage. Recommend or request escalation when a lower tier cannot support the desired conclusion, but
do not silently widen resource use or weaken a committed QA case's prerequisites.

## Workflow

### 1. Understand and classify

Resolve the exact target and request. Read repository instructions, the relevant source/release context, existing tests,
QA cases, observability, and environment guidance needed to choose and justify the tier. Do not scan or start unrelated
surfaces merely because they exist.

### 2. Prepare the selected tier

For `test-only`, prepare the documented test command and capture path. For `focused-local`, establish the relevant local
capabilities and safe reset path. For `full-isolated`, build the complete disposable harness and reach `QA READY`.
Record environment facts and capability gaps before task execution.

### 3. Scope and record

Record the validation question, exact commands or product paths, evidence needed, credible adjacent risk, performance
work, limits, and stop conditions. A `test-only` run needs only a concise command scope; a `focused-local` plan begins
after its in-scope capabilities are ready; a `full-isolated` plan begins only after complete-harness `QA READY`.

### 4. Execute and adapt

Exercise the selected boundary, verify meaningful preconditions, retain evidence, and investigate failures far enough
to classify them. Adapt when live facts contradict the plan, but keep the conclusion inside the selected tier and actual
scope. Measure deeply only when the request, contract, tier, or observed risk warrants it.

### 5. Report and improve the quality system

Return exactly one status: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`. State the tier, exact target, validated scope,
environment, evidence, findings, proportional performance observations, limitations, artifact paths, and cleanup state.
A `PASS` never extends beyond what ran: test-only proves checks, focused-local proves the observed paths under its local
conditions, and full-isolated proves only the completed release/major-feature qualification scope.

Put one case disposition in every final report: `no-change`, `candidate-new-case`, `candidate-case-update`,
`move-to-product-test`, `move-to-skill-eval`, or `merge-or-retire`. Do not edit the committed case library during a run.
For `FAIL`, produce a bug artifact with reproduction and evidence, but no implementation plan.

## QA Case Maintenance

Maintain QA cases only as an explicit, separate task. Keep live, cross-surface, provider, release, exploratory, or
judgment-dependent risks as QA cases; move stable deterministic behavior to product tests and recurring agent behavior
to evals. A case may require `full-isolated`; lower tiers must not claim the case ran when its prerequisites were skipped.
