# Environment Recipes

Match environment cost to the selected tier and affected scope. `test-only` needs no live QA slot, while both live tiers
prefer one QA-owned warm environment outside the source repository.

## Standing Warm Environment

- Keep one warm environment per QA workspace. It may retain the bare source cache, dependency cache, built images,
  Docker network, stopped or healthy reusable services, and external artifact root.
- Give each task a stable task key and exclusive slot. Reuse that slot across retries and target revisions instead of
  cloning, installing, and booting from zero each time.
- Before reuse, record the warm-environment ID, profile/toolchain versions, task key, exact target, lease owner, service
  health, mutable-state baseline, and the reset needed for the selected scope.
- Between tasks, reset task-owned databases, schemas, volumes, files, ports, processes, browser state, provider sessions,
  and credentials. Release the task lease but retain compatible infrastructure; report it as retained, not leaked.
- Never treat retained mutable state as clean isolation. If the reset cannot make attribution credible, repair or replace
  the affected slot, narrow the conclusion, or report `BLOCKED`/`INCONCLUSIVE`.

## `test-only`

Run the smallest documented test command that covers the exact target. In First Tree, prefer the relevant package or
named suite for a localized change and use `pnpm test` for repository-wide requests or shared-input impact. Reusing
dependency caches is allowed; do not start product services solely to make this tier look like live QA.

## `focused-local`

- Prefer the exact-target worktree already assigned to the task slot and reuse compatible dependencies and services.
- Start only affected surfaces and the nearest boundary needed by the validation question. Docker is optional.
- Before reusing the warm slot or another local dependency, record its owner, target/config, mutable state, and health.
- Do not write into valuable or operator-owned databases, homes, browser profiles, provider sessions, or credentials.
  Create run-local data/config whenever the scenario mutates state.
- Assign ports and process names narrowly enough to avoid collisions. Reset only task-owned state, retain compatible
  infrastructure after the report, and record residual shared state as a limitation.
- If shared state prevents attribution, safe reset, or credible evidence, stop with `BLOCKED`/`INCONCLUSIVE` or escalate
  only when the request authorizes `full-isolated`.

## `full-isolated`: Reusable Exact-Target Source Slot

Keep the bare clone in the warm environment and give the task one exact-target worktree:

```bash
QA_WARM_ROOT=<qa-workspace>/warm
QA_TASK_ROOT="$QA_WARM_ROOT/tasks/<task-key>"
mkdir -p "$QA_TASK_ROOT/artifacts"
QA_TASK_ROOT_REAL=$(realpath "$QA_TASK_ROOT")
git --git-dir="$QA_WARM_ROOT/repo.git" worktree add --detach "$QA_TASK_ROOT_REAL/source" <target-ref>
```

Create or fetch the warm bare clone when the environment is first provisioned or refreshed. `realpath` matters because
git stores absolute worktree paths; mount the resolved task root at the same absolute path inside containers.

Reuse the task worktree while the task remains active. When its exact target changes, record the new target and reset or
rebuild only affected artifacts before rerunning. This recipe materializes committed refs only; if requested behavior
depends on unreproducible local state, report the limitation or `BLOCKED` and never silently test a different target.

## `full-isolated`: Scoped Docker Slot

- Take an exclusive lease on the warm Docker environment and reset task-owned networks, volumes, homes, ports, and data.
- Select affected surfaces and critical adjacent boundaries before setup. Build and start only that scope; build every
  shipped or publicly promised surface only when the request explicitly requires release-wide qualification.
- Bind public endpoints to loopback and discover dynamic host ports after startup.
- Do not expose Postgres, artifacts, provider homes, runtime homes, or host credential stores.
- Use native or platform bridges for artifacts that cannot execute credibly in Linux Docker; keep their state run-local.
- Define reset and retained-infrastructure state for every selected surface before declaring scoped `QA READY`.

`QA READY` applies only to the recorded isolated scope. Keeping the warm environment after the task does not broaden the
claim; the report must distinguish task reset from retained infrastructure.

## Provider Bridge

Classify provider readiness as `binary-detected`, `binary-launchable`, or `one-turn-ready`. A provider-backed product
operation requires `one-turn-ready`; a binary probe alone cannot prove real agent behavior.

For either live tier, use a task-scoped provider session in the warm environment rather than the operator's existing
session. Reset it between tasks. For `full-isolated`, discover host state first, bridge only the minimum required
material, prefer read-only copies/mounts, and use a compatible runtime binary. Never mount a full host provider home
writable. Missing auth, entitlement, compatible binaries, or authorized turn capacity is `BLOCKED`, not product `FAIL`.

## Mock GitHub App

The GitHub App surface (install-url, installation-token minting, repository catalog, signed webhook ingest) needs a
configured App. A real App/webhook secret is often unavailable to a QA run, so it may report those sub-areas `BLOCKED`,
or mock them to validate First Tree's own request/parse/verify logic. Reusable assets live in `fixtures/github-app/`
(mock REST API + webhook payloads + full recipe).

- The five core credentials — `FIRST_TREE_GITHUB_APP_ID`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_PRIVATE_KEY`,
  `_WEBHOOK_SECRET` — are an atomic block: set them together or the server rejects the config at boot. `_SLUG` is separate
  — optional at boot, required only for `install-url`. A clean boot omits the "GitHub App not configured" log line and the
  webhook route stops returning its 501 stub.
- Generate a throwaway PKCS#8 key at run time (`openssl genpkey -algorithm RSA`); never commit one. Pass the multi-line
  PEM via a shell export, or a quoted `--env-file` value (Node 22.13+ supports quoted multi-line env values) — the export
  just avoids the quoting/escaping fuss.
- Redirect REST calls with `FIRST_TREE_GITHUB_API_BASE_URL` set to a URL the server can reach (`localhost` only if the
  mock shares the server's container; otherwise the compose service name or `host.docker.internal`). The mock answers two
  endpoints only (token + repos), so paths needing other GitHub REST — a real `follow`'s `/repos/:o/:r` +
  `/repos/:o/:r/issues/:n`, OAuth, org repos — fall through and stay out of scope.
- Sign webhooks with `x-hub-signature-256: sha256=<HMAC-SHA256(webhook_secret, raw_body)>` and set `x-github-event` /
  `x-github-delivery`. This exercises signature verification, record-only install recording, and delivery-id dedup.

A mock proves the deployment's request/parse/verify wiring, not github.com's live responses; the real install dialog and
full followed-chat card delivery stay outside the claim in every tier.
