# Tier Selection And Setup Briefing

Choose the lowest-cost First Tree QA tier that can support the requested conclusion, then prepare only the environment
required by that tier.

## Selection

- `test-only`: deterministic automated checks are sufficient, or the user asked only to run tests.
- `focused-local`: ordinary feature validation, defect reproduction, or focused performance work needs real product
  behavior but not release-wide qualification.
- `full-isolated`: the request is a release preflight/qualification, a clearly major or high-risk feature, or explicitly
  asks for complete isolated QA.

Record the selected tier and rationale before starting services. A vague request does not automatically select
`full-isolated`.

## `test-only` Setup

Resolve the exact target and use `pnpm test` by default. An explicitly narrow request may use the matching package or
named-suite command. Choose a safe output capture path and record the command; do not create a run cell, capability
matrix, plan, or `QA READY` claim.

## `focused-local` Setup

Scope the validation question, then establish these capabilities only for relevant surfaces:

- `Build`: exact artifact or development build;
- `Run`: required dependencies, configuration, data, startup, and health;
- `Drive`: a real user, operator, consumer, protocol, device, or provider action;
- `Observe`: credible product output or independent state readback;
- `Measure`: lightweight signals relevant to the question;
- `Reset`: a safe way to repeat the observation and clean owned state.

Prefer an exact-target worktree. Docker is optional. Before reusing a local dependency or service, record its
owner/config/state and confirm the run cannot damage valuable or operator-owned data; otherwise start run-local state.
Do not borrow existing logged-in browser/provider sessions or writable credential homes.

## `full-isolated` Setup

Create a disposable complete harness without mutating the operator's checkout, credentials, or shared services. Use a
temporary run root, run-local bare clone and detached worktree, unique Docker project, isolated networks/volumes/homes,
and an external artifact directory. Use native, device, or provider bridges only where Docker cannot credibly host a
surface.

For every shipped or publicly promised surface, establish Build, Run, Drive, Observe, Measure, and Reset. Resolve real
paths before sharing them with Docker, bind public endpoints to loopback by default, record artifact identities and
dynamic endpoints, continue safe independent probes after a gap, and separate target failures from setup failures.

Declare `QA READY` only when every full-tier surface has all six capabilities. Record a lightweight performance baseline
and reset smoke for each surface. If readiness fails, preserve the matrix and report the supported status without
entering formal task execution.

Retained artifacts are process output, not source. Summarize them to the requester and never commit them to the tested
repository.
