# QA Run Context

## Target And Tier

- Object/ref:
- Artifact identities:
- Tier: `test-only` | `focused-local` | `full-isolated`
- Tier rationale:
- Maximum supported conclusion:

## Environment

- Source worktree:
- Run/artifact root:
- Started or reused services and ownership:
- Docker project/images, if any:
- Native/device/provider bridges, if any:
- Data, identities, credentials, and isolation limits:
- Cleanup owner:

## Capability Matrix

Required only for the surfaces selected by `focused-local` or every formal surface in `full-isolated`.

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
- `full-isolated`: `QA_READY` | `FAIL` | `BLOCKED` | `INCONCLUSIVE`
- Evidence, gaps, reset, and cleanup path:
