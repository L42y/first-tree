# QA Run Context

## Target And Tier

- Object/ref:
- Artifact identities:
- Tier: `test-only` | `focused-local` | `full-isolated`
- Tier rationale:
- Changed paths / requirement size and risk:
- Selected surfaces and adjacent boundaries:
- Maximum supported conclusion:

## Environment

- Source worktree:
- Run/artifact root:
- Warm-environment ID/profile and task key:
- Lease/reuse decision, previous target, and current exact target:
- Pre-reuse health and mutable-state baseline:
- Started or reused services and ownership:
- Docker project/images, if any:
- Native/device/provider bridges, if any:
- Data, identities, credentials, and isolation limits:
- Task reset owner and retained infrastructure:

## Capability Matrix

Required only for the surfaces selected by either live tier.

| Surface | Build | Run | Drive | Observe | Measure | Reset | Evidence / gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

## Commands Or Services

- Test commands:
- Started services/endpoints:
- Health and precondition evidence:

## Readiness Outcome

- `test-only`: `NOT_APPLICABLE`
- `focused-local`: `IN_SCOPE_READY` | `FAIL` | `BLOCKED` | `INCONCLUSIVE`
- `full-isolated`: scoped `QA_READY` | `FAIL` | `BLOCKED` | `INCONCLUSIVE`
- Evidence, gaps, task reset, lease release, and retained-environment state:
