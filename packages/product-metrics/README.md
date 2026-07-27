# Product metrics

Deterministic, offline reporting for the First Tree acquisition funnel, formal
registration, DAU, retention, and interaction depth.

The package deliberately separates metric computation from data access:

- PostgreSQL extraction queries normalize product records to pseudonymous
  global-user and exact-timestamp activity facts.
- An optional visitor export supplies anonymous Web arrivals.
- TypeScript computes every window and cohort from one explicit `as_of`
  timestamp and IANA time zone.

No message bodies, credentials, names, email addresses, or other direct
identifiers are required.

## Definitions

### Formal registration

A global user is formally registered only after one internally consistent
membership path has reached these stages in order:

1. account authenticated;
2. client ready, or that step legitimately skipped;
3. agent ready, or that step legitimately skipped;
4. the onboarding bootstrap is stored in the user's kickoff chat; and
5. the user sends a later organic message.

The first kickoff message and other trusted automation can be server-authored
in the member's voice. They are excluded from registration, DAU, retention,
and depth even when the database sender is the human agent. New trusted paths
receive a protected `serverAuthored` provenance marker at the message write
boundary; extraction also recognizes legacy kickoff, cron, recovery, and
Context Reviewer/system-sender markers. A bootstrap-only user is not
registered.

The reporting cohort is operational and intentionally distinct from product
activation: a first message proves active use, but not necessarily that the
user completed a valuable work loop.

### Activity and retention

An active or returning user has at least one organic, user-authored message in
canonical message history after formal registration. Passive page views are
not DAU or retention.

- Daily retention is exact-day return on D1-D7, D14, and D30.
- Weekly retention is any return day in the ISO Monday-Sunday target week,
  reported for W1-W4.
- A retention denominator is emitted only after the whole target day or week
  is complete.
- Daily and weekly depth count organic user messages per active global user,
  split into users registered in that period (`new`) and earlier registrants
  (`retained`).

### Funnel windows

`yesterday` and `last7Days` are complete local calendar windows immediately
before `as_of`. Funnel rows are acquisition cohorts: an account is assigned by
its first authentication, and a visitor by its durable first-visit event.
Later stages are observed through `as_of`, so recent funnels are explicitly
right-censored and can improve on later reruns.

`allUniqueVisitors` is also reported for traffic context. It includes every
visitor seen in the window, while `acquisitionVisitors` is the first-visit
cohort used as the funnel denominator.

## Data extraction

In pgAdmin, run the two PostgreSQL queries in one read-only repeatable-read
transaction and export each result as CSV:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT CURRENT_TIMESTAMP AS as_of;
```

1. `sql/postgres/user-journeys.sql` -> `user-journeys.csv`
2. `sql/postgres/daily-activity.sql` -> `daily-activity.csv`

Finish with `ROLLBACK`, never `COMMIT`.

The PostgreSQL fallback observes intermediate client/agent evidence where it
exists. `clients.connected_at` is mutable on reconnect and is not a durable
first-connect event, so it is marked `observed_connected`; completed paths
without a reliable observation are marked `inferred_completed`. An
event-pipeline export may replace those facts with exact `connected` timestamps
while keeping the same CSV contract.

### Visitor input

`visitor-visits.csv` has these columns:

| column | meaning |
| --- | --- |
| `visitor_id` | stable pseudonymous first-party or analytics visitor ID |
| `visited_at` | visit timestamp with an explicit UTC offset |
| `is_first_visit` | durable lifetime first-visit flag, not the first row in a truncated export |
| `user_id` | optional global user ID from a privacy-reviewed first-party identity bridge |

First Tree currently records anonymous Web analytics separately from
authenticated product records. Without an explicit identity bridge, pass
`--visitor-identity-bridge unavailable`. The report still returns anonymous
traffic totals, but intentionally withholds visitor-to-registration stage
conversion rather than joining unrelated aggregates.

## Run

```bash
pnpm --filter @first-tree/product-metrics build
pnpm --filter @first-tree/product-metrics report \
  --journeys user-journeys.csv \
  --activity daily-activity.csv \
  --visits visitor-visits.csv \
  --visitor-identity-bridge unavailable \
  --as-of 2026-07-27T09:57:31.963977Z \
  --time-zone Asia/Taipei \
  --output report.json
```

Omit `--visits` when no visitor export is available. Visitor totals are then
`null` rather than a misleading zero. The output remains machine-readable JSON
and includes data-quality counts and warnings alongside the metrics.
