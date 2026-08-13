# Execute And Report Briefing

Execute only the boundary authorized by the selected tier.

## Execution Loop

- `test-only`: run the recorded test commands, capture exit results and material failures, and do not infer live product
  behavior from assertions alone.
- `focused-local`: confirm relevant capabilities and reset paths remain credible, then exercise the planned product
  boundaries under the recorded local conditions.
- `full-isolated`: confirm scoped `QA READY` and the post-readiness plan, then exercise only the selected isolated
  final-artifact, cross-surface, provider, installer, persistence, recovery, performance, or exploratory paths.
- For live tiers, verify meaningful preconditions and use credible product output or independent readback.
- Save evidence as it occurs, adapt when facts contradict the plan, and keep every conclusion within the actual tier and
  scope.
- Use `BLOCKED` for unmet external/setup preconditions and `INCONCLUSIVE` for partial, unstable, interrupted,
  contradictory, or unattributable evidence.

## Evidence And Reporting

Return one overall status: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`. Include:

- exact target, selected tier, and maximum conclusion supported;
- commands or product scope that actually ran;
- environment/capability facts and non-isolation limits;
- evidence and reproducible findings;
- performance observations proportional to the tier and question;
- skipped, blocked, unstable, escalated, or out-of-scope areas;
- artifact paths, task-owned reset, and retained warm-environment state;
- case disposition: `no-change`, `candidate-new-case`, `candidate-case-update`, `move-to-product-test`,
  `move-to-skill-eval`, or `merge-or-retire`.

For `FAIL`, produce a bug artifact with reproduction, expected/actual behavior, evidence, impact, and likely dispatch
surface, but no implementation plan. Record case feedback without editing the committed case library during the run.
