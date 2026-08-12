---
id: runtime-readiness-verification
description: Verify the on-demand host-local readiness check through a real official provider runtime without repository, tool, credential, or task side effects.
areas: [runtime, onboarding]
surfaces: [client, cli, server, web]
---

# Runtime Readiness Verification

## Goal

Prove that an installed provider is reported `ready` only after the exact daemon runtime can complete one controlled
authenticated turn, and that login recovery, caching, isolation, and safe read-model states work through the shipped
Client/Server boundary.

Use `focused-local` for an ordinary feature run. Use an exact-head local build and the repository's `local` environment.
This case does not approve onboarding visual design; until that UI is selected, drive the Web API boundary directly.

## Preconditions

- Use a dedicated disposable QA provider identity on the daemon host. Do not borrow an operator's logged-in provider
  session or copy credentials into the repository, chat, screenshots, command history, or retained evidence.
- Record the exact git head, Client/CLI build identity, server instance, provider, resolved runtime source/path/version,
  and configured model identity without recording tokens, cookies, prompts, or provider output.
- Start the exact-head local services using the repository-maintained commands and wait for readiness. If a visible Web
  flow is added later, run it with Momentic's `local` environment and upload the result; direct API evidence is sufficient
  only while this change intentionally has no production UI.
- Capture baseline repository status, user Task count, and Context/Memory write counters or equivalent query evidence.
  Arrange OS filesystem tracing (`fs_usage`, `strace`, or equivalent) that can identify reads under the target repository.

If no dedicated provider identity can safely exercise both logged-out and logged-in states, report the affected live
steps as `BLOCKED`; install-only detection and mocked product tests are not substitutes.

## Checklist

1. With the provider executable installed but the dedicated identity logged out, trigger readiness through
   `POST /api/v1/clients/:clientId/runtime-readiness/start`. Poll the Client read model and verify the sequence reaches
   `needs_login`, never `ready`.
2. Start the existing runtime-auth recovery for the same provider. Complete the provider's official host-local login and
   verify the daemon automatically rechecks readiness, converging through `checking` to `ready` without a second
   readiness request.
3. Verify the readiness run uses the same resolved provider runtime source/path and local identity as a normal Agent
   session. Confirm only one turn ran, no tool/MCP/web-search event occurred, the working directory was a generated
   empty temporary directory, and no target-repository read appeared in filesystem tracing.
4. Confirm the temporary directory is removed, the repository status is unchanged, and no user-visible Task, Context,
   Memory, or other product record was created or changed by the verification.
5. Reissue an ordinary non-forced readiness request while the successful result is fresh, and reload/read the Client
   endpoint repeatedly. Verify no additional provider turn runs and the cached `ready` result is reused.
6. Trigger concurrent same-identity requests and verify only one provider turn runs. Trigger a different provider/runtime
   or material configuration identity and verify the old result cannot be reused or overwrite the newer check.
7. Advance beyond the configured freshness window or use an equivalent controlled clock. Verify the API projects
   `expired`; disconnect the computer and verify `computer_offline`. Reconnect and explicitly recheck to recover.
8. Cause a provider-auth failure after a prior success and verify the cached success is invalidated to `needs_login`.
   Cause a timeout and a non-auth provider failure and verify bounded `failed` results without an unhandled daemon error.
9. Inspect retained Client capability payloads, Server/Web responses, daemon logs, and traces. They may contain only the
   bounded verdict/identity/timestamps/error preview: no credential, full prompt, or provider/model output.
10. Run one normal Agent session after readiness verification and confirm existing install-only capability `state=ok`
    and normal provider behavior are unchanged.

## Evidence

Retain sanitized API response sequences, provider invocation counts, runtime identity facts, filesystem-trace filters,
before/after repository and product-record comparisons, daemon state-transition logs, and any uploaded Momentic run URL.
Never retain the model's full output or the readiness prompt; record only that the controlled turn completed.

## Expected Result

- Logged-out installed runtimes stop at `needs_login`; successful official login automatically converges to `ready`.
- Readiness is isolated, one-turn, tool-free, repository-free, non-mutating, redacted, bounded, cached, and deduplicated.
- Expiry, offline state, provider/runtime/config changes, auth failure, timeout, and stale completion fail safely.
- Existing capability detection and normal Agent sessions retain their previous behavior.

Report exactly one QA status and one case disposition. A missing provider credential/environment is `BLOCKED`, not
`PASS`; deterministic tests can still be reported separately.
