# @first-tree/qa

First Tree-specific QA assets consumed by the shipped `first-tree-qa` skill.

The skill owns the general principles and risk-tiered lifecycle. This package is the repository-specific authority for
selecting among `test-only`, `focused-local`, and `full-isolated`, and for applying First Tree commands, environments,
cases, evidence rules, and templates. It does not define a competing workflow.

Deterministic behavior belongs in product tests. Recurring agent behavior belongs in `@first-tree/skill-evals`. Live,
cross-surface, provider-backed, release, exploratory, or judgment-dependent validation belongs here at the lowest tier
that can support the requested conclusion.

## Tiers At A Glance

- `test-only`: run matching package/named tests for localized changes and use `pnpm test` for repository-wide scope.
- `focused-local`: reuse the QA warm environment and start affected surfaces plus necessary adjacent boundaries.
- `full-isolated`: use an exclusive clean slot in the same warm environment for the selected release-sensitive,
  clearly major/high-risk, cross-surface, or explicitly isolated scope.

The QA agent keeps one compatible warm environment outside the source repository. A task reuses its slot across retries
and target revisions; task-owned mutable state is reset between tasks, while healthy infrastructure is retained and
reported rather than torn down after every run.

## Run Artifacts

Keep retained output outside the repository and make it proportional to the tier:

- `test-only`: exact target, command, exit result, duration when available, and material failure output; no QA plan or
  capability matrix is required.
- `focused-local`: a concise `run-context.md`, `plan.md`, relevant evidence, and `report.md` recording reuse,
  non-isolation, task reset, and retained infrastructure.
- `full-isolated`: the selected isolated-scope matrix and scoped `QA READY` outcome in `run-context.md`, a
  post-readiness `plan.md`, evidence, and the final `report.md`.

Start from `templates/` when useful.

## Directory Map

- `AGENTS.md` contains the authoritative First Tree tier rules and QA contract.
- `briefings/` covers tier setup, planning, execution, and reporting.
- `cases/` stores reusable prose QA cases and authoring guidance.
- `environment/` provides focused-local and full-isolated recipes and bridges.
- `observability/` covers evidence, performance, and redaction.
- `templates/` contains minimal run artifact templates.
- `fixtures/` stores reusable, non-sensitive assets, never run output.

The package deliberately has no public runner, lifecycle CLI, case validator, or CI gate.
