# Plan Briefing

Use a plan only for `focused-local` or `full-isolated`. A `test-only` run records its exact target and commands without a
separate QA plan.

For `focused-local`, create the plan after the in-scope Build/Run/Drive/Observe/Measure/Reset capabilities are credible.
For `full-isolated`, create it only after the complete harness is `QA READY`.

## Input

Use the original request, exact target, selected tier, run context, repository/Context Tree context, existing tests, and
the case library. Ask a human only when a product or scope decision cannot be resolved from those inputs or a safe
conservative default.

## Steps

- State one validation question and the maximum conclusion the selected tier can support.
- Select relevant product paths, credible adjacent risk, existing cases, and task-specific exploratory checks.
- Choose data, identities, roles, failure/recovery branches, and reset points from the prepared environment.
- Choose real-product evidence and performance work required by the question or risk.
- Record out-of-scope behavior, non-isolation limits, resource limits, escalation conditions, and stop conditions.

Do not weaken a committed case to fit a lower tier. If its prerequisites require `full-isolated`, either select that tier
when the request authorizes it or leave the case unexecuted and limit the conclusion.

## Plan Shape

- target, request, selected tier, and validation question;
- reference to the prepared run context;
- in-scope surfaces, journeys, tests, cases, and task-specific checks;
- data and identity setup and reset points;
- evidence and performance work needed for the conclusion;
- out-of-scope behavior, limits, escalation condition, and `BLOCKED`/`INCONCLUSIVE` stop conditions.

If data creation is itself under test, create it through the product. Direct fixture or database setup is acceptable only
as a recorded precondition and is not product-behavior evidence.
