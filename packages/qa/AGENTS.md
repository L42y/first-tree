# QA Package Instructions

`@first-tree/qa` contains the First Tree-specific assets used by the shipped `first-tree-qa` skill: tier rules, reusable
briefings, natural-language QA cases, environment recipes, evidence guidance, templates, and fixtures. The skill owns
the core QA principles and lifecycle; this package is the repository-specific authority for how First Tree applies them.

It is not a test runner, CLI, or CI gate. Stable deterministic behavior belongs in product tests, recurring agent
behavior belongs in `@first-tree/skill-evals`, and live or judgment-dependent behavior may use focused or full QA.

## Tier Selection

Choose the lowest tier that can support the requested conclusion and record the choice before setup.

| Tier | Use it for | Environment | Maximum honest conclusion |
| --- | --- | --- | --- |
| `test-only` | Deterministic integration/regression checks or an explicit test request | Run `pnpm test` by default; an explicitly narrow request may use the matching package command | Only the reported automated checks passed or failed |
| `focused-local` | Ordinary feature validation, defect reproduction, or focused performance work | Start only relevant surfaces locally; Docker and full isolation are optional | Only the observed paths passed or failed under the recorded local conditions |
| `full-isolated` | Release preflight/qualification, a clearly major or high-risk feature, or an explicit complete-QA request | Temporary worktree plus Docker-backed isolated cell and necessary native/provider bridges | Only the completed release or major-feature qualification scope passed or failed |

Do not select `full-isolated` merely because Docker is available, a committed case exists, or the request is vague. A
lower tier may recommend escalation, but it must not claim release readiness or silently weaken a case that requires the
full tier.

## Invariants For Every Tier

A result cannot be `PASS` when an applicable invariant is violated:

1. Resolve and report the exact target, selected tier, scope, commands or product paths, and evidence boundary.
2. Do not modify product source while testing. Product fixes and committed case maintenance are separate tasks.
3. Require evidence from the boundary actually claimed: test output for `test-only`; real relevant product behavior for
   `focused-local`; complete-harness and real product evidence for `full-isolated`.
4. Keep retained run artifacts outside the source repository and redact secrets, credentials, private sessions, and
   user data.
5. Separate target failures from environment, dependency, credential, provider, platform, data-precondition, or
   insufficient-evidence failures.
6. Report exactly one status and one case disposition, and state cleanup or residual state honestly.

## Tier Requirements

### `test-only`

- Run `pnpm test` for repository-wide deterministic validation unless the request clearly limits the target to a package
  or named suite.
- Record the exact command, exit code, duration when available, and failing test identifiers or output.
- Do not create a Docker cell, capability matrix, QA plan, or `QA READY` claim.
- A passing test command is not live-product, provider, cross-surface, performance, or release evidence.

### `focused-local`

- Prefer an exact-target worktree. Start only the services and product surfaces needed by the validation question.
- Local non-isolated startup is allowed. Inventory any reused dependency or service first, record its owner/config/state,
  and do not mutate valuable or operator-owned data. Use run-local data/config for write paths when practical.
- Establish Build, Run, Drive, Observe, Measure, and Reset for the in-scope surfaces before executing the planned
  behavior. A lightweight `plan.md` may then record the focused scope.
- Docker is optional. Never reuse an operator's logged-in browser/provider session or mount writable host credential
  homes solely for convenience.
- Stop and report limitations if shared state makes attribution, cleanup, or a `PASS` conclusion unreliable.

### `full-isolated`

- Use a Docker-backed cell plus a temporary git worktree, not the operator's checkout or shared local services. Explicit
  native, device, or provider bridges are allowed only when a formal surface cannot live credibly inside Docker.
- Before `QA READY`, build, run, drive, observe, measure, and reset every shipped or publicly promised First Tree surface.
  A narrow focus changes execution scope after readiness; it does not shrink the full harness.
- Do not select cases or write the formal task QA plan before complete-harness `QA READY`; a provisional readiness
  checklist and run context are allowed.
- A blocked capability does not stop safe independent readiness probes. Preserve the full matrix, evidence, and available
  performance samples before reporting.

## Lifecycle

1. Resolve the exact target and enough repository, issue/PR/design, Context Tree, release, CI, and QA context to choose a
   tier.
2. Record the tier and rationale, then prepare only that tier's required environment and evidence path.
3. Record scope: a command list for `test-only`, a post-capability focused plan for `focused-local`, or a post-`QA READY`
   formal plan for `full-isolated`.
4. Execute through the selected boundary, adapt to live facts, and retain evidence tied to conclusions.
5. Report status, tier, scope, performance proportional to the tier, limitations, artifact paths, cleanup, and case
   disposition.

Use one disposition: `no-change`, `candidate-new-case`, `candidate-case-update`, `move-to-product-test`,
`move-to-skill-eval`, or `merge-or-retire`. Apply the recommended change only in a separate maintenance or product-work
task.

## Result Statuses

- `PASS`: every check in the reported tier and scope completed with sufficient evidence and no attributable product
  issue was found.
- `FAIL`: a reproducible defect or deterministic test failure attributable to the exact target was found. Produce a bug
  artifact when reproduction detail is needed.
- `BLOCKED`: environment or external preconditions prevented required setup or validation.
- `INCONCLUSIVE`: evidence is incomplete, unstable, interrupted, contradictory, or unattributable.

## Package Boundaries

- Put First Tree case authoring guidance and reusable cases under `cases/`.
- Put tier-specific repository guidance under `briefings/`.
- Put local/full environment and provider-bridge recipes under `environment/`.
- Put evidence, performance-observation, and redaction guidance under `observability/`.
- Put minimal run artifact templates under `templates/`.
- Put reusable, non-run-specific assets under `fixtures/`.
- Do not add a public runner, lifecycle CLI, or CI gate without a separate design decision.
