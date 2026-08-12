# Evidence And Performance Guidance

Every conclusion must point to evidence from the boundary it claims. Evidence volume and performance work should match
the selected tier.

## Evidence By Tier

- `test-only`: exact target, command, exit status, duration when available, and material failure output. This is
  automated-check evidence only.
- `focused-local`: relevant CLI/API/Web/SDK/runtime output plus credible state readback, recorded local environment and
  shared-state limits, and targeted performance samples when the question needs them.
- `full-isolated`: final-artifact and public-boundary evidence across the selected ready scope, reset/recovery evidence,
  and performance characterization proportional to the isolated risk.

Possible evidence includes CLI output and installed files; HTTP/API/WS observations; database state and restart
behavior; browser-visible state, screenshots, console/network/a11y output; SDK consumer, daemon/worker, provider,
installer, migration, and portable-artifact observations.

Source, logs, mocks, test assertions, and direct database setup help diagnosis or establish preconditions but do not
prove public behavior they never exercised.

## Performance

- `test-only`: record command duration when useful; do not infer runtime performance.
- `focused-local`: measure only the in-scope startup, latency, resource, or reset signals needed by the request or an
  observed risk, and label the local/non-isolated environment.
- `full-isolated`: during scoped slot initialization, capture dependency/build duration, final artifact size,
  start-to-ready/first-consumer duration, idle resources, driver/observer response, and reset/reprobe duration for each
  selected surface when applicable.

One sample proves measurement capability, not a statistical regression. Run deeper sampling only when the task, SLO,
case, change risk, or observed issue requires it. State workload, environment, sample count, cold/warm state, raw errors,
and baseline/SLO before claiming a regression.

## Redaction

Redact tokens, cookies, auth headers, provider credentials, private connection strings, personal data, and private
session content. Keep enough sanitized context to interpret the result and retain sensitive evidence only at safe local
paths.
