# Adding a runtime provider

One-page contract for extending the known provider set. Keep Handler V1 and
generic lifecycle ownership unchanged — do not invent Handler V2 or move
ACK / Reset / auth / model / persistence protocol into shared catalog.

## Ownership model

**Single known-provider identity + composition-owned exhaustive projections.**

| Layer | Owns |
| --- | --- |
| Zod `runtimeProviderSchema` | Wire IDs → `RuntimeProvider` / `RUNTIME_PROVIDER_IDS` / generated `RUNTIME_PROVIDERS.*` |
| Shared `RUNTIME_PROVIDER_CATALOG` | Labels, `displayOrder`, `selectionPriority`, install/login, auth-owner copy |
| `createBuiltinHandlerRegistry` | Frozen `Record<RuntimeProvider, HandlerFactory>` (consumed once by `registerBuiltinHandlers`) |
| `BUILTIN_PROVIDER_PROBES` | Frozen install-only capability probes |
| `PROVIDER_SKILL_ROOTS` | Frozen native managed-skill roots |

Probe/skills paths do **not** consume a full installed handler registry.

## 1. Identity

1. Add the wire id to `runtimeProviderSchema` only.
2. Types, `RUNTIME_PROVIDER_IDS`, and `RUNTIME_PROVIDERS` (kebab → `UPPER_SNAKE`) derive from that schema — no parallel handwritten value lists.
3. Narrow unknown strings with `asRuntimeProvider` / `runtimeProviderLabel`.

## 2. Shared catalog (pure data)

Add an exhaustive catalog entry:

- `label`, unique `displayOrder`, unique `selectionPriority` (may differ — both locked in tests)
- `install`: `{ kind: "npm", package, args }` (`args` required, use `[]` when none) or `{ kind: "script", command }`
- `loginSteps`: one shell step, or two for interactive (`kimi` + `/login`)
- `authOwnerLabel` for chat auth-recovery

Helpers derive install/login/chat phrases. Share version constants with
capability gates — do not reverse-parse package strings.

**Login default:** new providers are provider-owned login (CLI / interactive
steps from the catalog). Adding in-product OAuth requires a separate
runtime-auth contract + tests — do not sneak OAuth into the catalog entry.

## 3. Handler V1 contract

Each factory must provide `start` / `resume` / `inject` / `suspend` /
`shutdown`. The adapter only translates provider protocol ↔ First Tree
events. Session lifecycle, ACK / recovery / retry, Reset, and persistence
belong to the generic runtime — adapters must not re-implement them.

## 4. Runtime config

Extend the Zod discriminated runtime payload / defaults first. Supported
fields pass through unchanged; unsupported fields fail explicitly. Silent
fallback to another provider or default config is forbidden.

## 5. Probe + skill root

- **Probe:** installation / artifact / platform only. Reuse the runtime binary
  resolver. Must be async. Must not launch the provider, open network auth,
  or read credentials.
- **Skill root:** only the fixed safe projection in `PROVIDER_SKILL_ROOTS`.
  Prompt / skills / MCP / auth / model provider-specific projection stays in
  adapter-owned modules.

## 6. Client composition checklist

1. Handler factory in `createBuiltinHandlerRegistry`.
2. Install probe in `BUILTIN_PROVIDER_PROBES`.
3. Skill root in `PROVIDER_SKILL_ROOTS`.
4. Binary remediation may re-export catalog install/login helpers; adapter
   protocol keywords stay local.

## 7. Minimum test gates

- Identity / catalog / composition projections exhaustive (and frozen).
- Unique `displayOrder` + unique `selectionPriority`.
- Handler lifecycle methods present for every known id.
- Probe isolation (no launch / auth / credential read).
- Managed-skill root safety (fixed projection only).
- Final UI copy / order (catalog helpers → rendered install/login + dialog order).
- Architecture guard tokens from `RUNTIME_PROVIDER_IDS`.
- QA case for the provider when coordinator publishes a candidate SHA.

## Out of scope

- Handler V2 / SessionManager split
- ACK / retry / Reset / persistence redesign
- Moving adapter protocol / SDK taxonomy into shared catalog
