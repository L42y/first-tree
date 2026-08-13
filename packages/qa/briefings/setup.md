# Tier Selection And Setup Briefing

Choose the lowest-cost First Tree QA tier and narrowest affected scope that can support the requested conclusion, then
reuse or prepare only the capabilities required by that scope.

## Selection

- `test-only`: localized deterministic automated checks are sufficient, or the user asked only to run tests.
- `focused-local`: ordinary feature validation, defect reproduction, or focused performance work needs real product
  behavior on affected surfaces but not isolated high-risk evidence.
- `full-isolated`: the affected scope is release-sensitive, clearly major/high-risk, cross-surface, or explicitly asks
  for isolated QA.

Record the selected tier, affected paths/surfaces, adjacent risks, and rationale before starting services. A vague or
large-looking request does not automatically select `full-isolated` or whole-product coverage.

## `test-only` Setup

Resolve the exact target and use the matching package or named suite for localized changes. Use `pnpm test` when the
request or changed shared inputs require repository-wide coverage. Choose a safe output capture path and record the
command; do not create a live slot, capability matrix, plan, or `QA READY` claim.

## `focused-local` Setup

Scope the validation question, inspect the task's existing warm-environment slot, then establish these capabilities only
for affected surfaces and necessary adjacent boundaries:

- `Build`: exact artifact or development build;
- `Run`: required dependencies, configuration, data, startup, and health;
- `Drive`: a real user, operator, consumer, protocol, device, or provider action;
- `Observe`: credible product output or independent state readback;
- `Measure`: lightweight signals relevant to the question;
- `Reset`: a safe way to repeat the observation and clean owned state.

Prefer the exact-target worktree and services already assigned to the task. Docker is optional. Before reuse, record the
warm-environment ID, task key, exact target, owner/config/state/health, profile compatibility, and reset status; otherwise
repair only the incompatible part. Do not borrow logged-in browser/provider sessions or writable credential homes.

## `full-isolated` Setup

Take an exclusive clean task slot in the QA-owned warm environment without mutating the operator's checkout,
credentials, or shared services. Reuse its bare clone, caches, images, and compatible services; use an exact-target
worktree, reset task-owned networks/volumes/homes/data, and keep artifacts outside the product repository. Use native,
device, or provider bridges only where Docker cannot credibly host an in-scope surface.

For the affected surfaces and critical adjacent boundaries selected from the PR/requirement, establish Build, Run,
Drive, Observe, Measure, and Reset. Initialize every shipped surface only for explicit release-wide qualification.
Resolve real paths before sharing them with Docker, bind public endpoints to loopback, record artifact identities and
dynamic endpoints, continue safe in-scope probes after a gap, and separate target failures from setup failures.

Declare `QA READY` only when every selected isolated surface has all six capabilities. Record a lightweight performance
baseline and reset smoke for each selected surface. If readiness fails, preserve the scoped matrix and report the
supported status without entering formal task execution.

After reporting, reset task-owned mutable state and release the task lease, but retain compatible warm infrastructure.
Retained artifacts are process output, not source; summarize them to the requester and never commit them to the tested
repository.
