# Adding a runtime provider

Short checklist for extending the provider set. This phase keeps Handler V1,
ACK/Reset, and persistence unchanged — do not invent Handler V2 or move auth /
model / lifecycle protocol into generic core.

## Ownership model

**Single known-provider identity + composition-owned exhaustive projections.**

| Layer | Owns |
| --- | --- |
| Zod `runtimeProviderSchema` | Wire IDs → `RuntimeProvider` / `RUNTIME_PROVIDER_IDS` |
| Shared `RUNTIME_PROVIDER_CATALOG` | Labels, display/selection order, install/login, auth-owner copy |
| `createBuiltinHandlerRegistry` | `Object.freeze`d `Record<RuntimeProvider, HandlerFactory>` (consumed once by `registerBuiltinHandlers`) |
| `BUILTIN_PROVIDER_PROBES` | `Object.freeze`d install-only capability probes |
| `PROVIDER_SKILL_ROOTS` | `Object.freeze`d native managed-skill roots |

Probe/skills paths do **not** consume a full installed handler registry. Tests assert
`Object.isFrozen(...)` on all three tables.

## 1. Identity

1. Add the wire id to `runtimeProviderSchema`.
2. Types and ID lists derive from that schema — no parallel lists.
3. Narrow unknown strings with `asRuntimeProvider` (`safeParse`).

## 2. Shared catalog (pure data)

Add an exhaustive catalog entry:

- `label`, `displayOrder`, `selectionPriority` (may differ — lock both in tests)
- `install`: `{ kind: "npm", package, args? }` or `{ kind: "script", command }`
- `loginSteps`: one shell step, or two for interactive (`kimi` + `/login`)
- `authOwnerLabel` for chat auth-recovery

Helpers derive install/login/chat phrases from those fields. Share version
constants (e.g. `OPENCODE_MINIMUM_VERSION`) with capability gates — do not
reverse-parse package strings.

## 3. Client composition

1. Handler factory in `createBuiltinHandlerRegistry`.
2. Install probe in `BUILTIN_PROVIDER_PROBES`.
3. Skill root in `PROVIDER_SKILL_ROOTS`.
4. Binary remediation may re-export catalog install/login constants; adapter
   protocol keywords stay local.

## 4. Tests + architecture guard

- Parameterized catalog completeness (every ID).
- Exhaustive key-set tests across the three composition tables.
- Guard tokens derive from `RUNTIME_PROVIDER_IDS` (auto-expands).
- Live consumers: NewAgentDialog / RuntimeSection / auth hint / runtime notice /
  binary remediation must use catalog helpers.
- Web: DOM assertion from catalog → rendered install/login copy.

## Out of scope

- Handler V2 / SessionManager split
- ACK / retry / Reset / persistence redesign
- Moving adapter protocol knowledge into shared catalog
