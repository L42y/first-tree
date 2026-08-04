---
id: runtime-provider-boundary
description: Cross-surface acceptance that provider identity, catalog metadata, and built-in registration stay behind one ownership boundary.
areas: [runtime]
surfaces: [client, cli, web]
---

# Runtime Provider Boundary

## Goal

Validate that First Tree's runtime-provider foundation keeps concrete provider
knowledge behind the shared catalog + client built-in registry boundary, while
generic runtime / web surfaces only consume injected or catalog-derived data.

Use this case after provider-registration / catalog refactors. It does **not**
replace product tests (`pnpm --filter @first-tree/shared|client|web test`); it
records the human cross-surface checks those tests cannot fully cover.

## Preconditions

- Work from a checkout that includes the provider-boundary change under review.
- Deterministic package tests for shared/client/web have already been run for
  the same revision.
- No product source edits while executing this case.

## Checklist

1. **Identity single source**
   - Confirm `RUNTIME_PROVIDER_IDS` in `@first-tree/shared` is the only identity
     list and that schema / catalog keys match it.
   - Confirm a disabled provider (currently `claude-code-tui`) stays a valid ID
     but is absent from enabled selection / probe aggregation.

2. **Web catalog derivation**
   - Open Computers / client setup cards and confirm provider labels, order, and
     install/login commands match the shared catalog (no divergent parallel
     strings in web-only tables).
   - Spot-check one npm provider (e.g. Codex) and one script installer
     (Cursor or Grok).

3. **Built-in registry wiring**
   - Confirm daemon boot still registers every known provider handler through
     `registerBuiltinHandlers` / `createBuiltinProviderRegistry`.
   - Confirm `first-tree daemon probe --json --no-upload` still returns entries
     for enabled providers only, and a single probe failure does not drop the
     rest of the snapshot.

4. **Skill roots**
   - Confirm managed-skills projection still maps each provider to its native
     root (Claude → `.claude/skills`, Codex/Pi → `.agents/skills`, etc.) without
     a second hard-coded map in generic aggregation.

5. **Architecture guard**
   - Confirm the committed provider-boundary guard test remains green: generic
     capability aggregation / handler registration do not reintroduce provider
     literal switches, and shared/web do not import provider SDKs.

## Evidence

Useful evidence includes: package test output for the boundary/guard suites,
`daemon probe --json --no-upload` excerpts (redact host paths if needed), and a
short note that web setup copy matched the shared catalog for the sampled
providers.

## Expected Result

`PASS` means the revision keeps provider identity/catalog/registry ownership
intact across shared, client, CLI probe, and web setup surfaces, with no
provider-literal regression in the guarded generic modules.

`FAIL` means a generic module regained concrete provider branches/lists, web
reintroduced a parallel provider table, probe aggregation diverged from the
enabled provider set, or skill-root mapping drifted from the registry source.

`BLOCKED` means the run cell could not exercise probe/UI surfaces for
environment reasons; record the gap and keep product-test evidence separate.
