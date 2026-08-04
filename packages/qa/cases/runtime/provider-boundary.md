---
id: runtime-provider-boundary
description: Cross-surface acceptance that provider identity, catalog metadata, and composition-owned projections stay behind one ownership boundary.
areas: [runtime]
surfaces: [client, cli, web]
---

# Runtime Provider Boundary

## Goal

Validate that First Tree keeps a single known-provider identity plus
composition-owned exhaustive projections (handler factories, install probes,
skill roots), while generic runtime / web surfaces only consume catalog-derived
or injected data.

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
   - Confirm Zod `runtimeProviderSchema` is the type source (`RuntimeProvider =
     z.infer<…>`, IDs from schema options).
   - Confirm a disabled provider (currently `claude-code-tui`) stays a valid ID
     but is absent from enabled selection / probe aggregation.

2. **Web catalog derivation**
   - Open Computers / client setup cards and confirm provider labels, display
     order, and install/login commands match the shared catalog.
   - Confirm New Agent always puts Codex before Claude Code, then preserves the
     selected Client's stable reported order for every other ready provider;
     staggered probe completion must not change that order, which may differ
     from setup-card display order.
   - Confirm the final RuntimeInstallBox output is install-only for all five
     in-product entries (Claude Code, Claude Code CLI, Codex, Cursor, Grok
     Build), while Kimi, OpenCode, and Pi include their provider-owned
     host-login guidance.
   - Confirm the four direct in-product providers target themselves and Claude
     Code CLI targets Claude Code's shared credential; host providers expose no
     First Tree runtime-auth target.

3. **Composition wiring**
   - Confirm daemon boot registers handlers through
     `registerBuiltinHandlers` / `createBuiltinHandlerRegistry` (factories only).
   - Confirm probe aggregation reads `BUILTIN_PROVIDER_PROBES` (or an explicit
     inject), not a process-global registry snapshot.
   - Confirm `first-tree daemon probe --json --no-upload` still returns entries
     for enabled providers only, and a single probe failure does not drop the
     rest of the snapshot.
   - Confirm the runtime-auth driver projection covers exactly the
     server-accepted in-product targets, with no host-login provider and no
     separate entry for the shared-credential Claude Code CLI target.

4. **In-product login boundary**
   - Confirm a Connect on each in-product target still walks pending → sign-in
     URL (when the provider emits one) → re-probe, and that an unresolved
     artifact, a failed or thrown login, and a thrown re-probe each end with a
     published capability entry rather than a stuck pending row.
   - Confirm a Claude Code login refreshes both Claude rows while the CLI/TUI
     entry is enabled, and touches only the Claude Code row while it is
     centrally disabled.
   - Confirm a long or noisy login run does not grow daemon memory with
     retained login output, reports an external sign-in URL exactly once even
     when it arrives split across output chunks, and never reports a loopback
     callback URL.
   - Confirm every published `lastAuthError.message` is length-bounded and
     carries no credential or token text, including errors originating from the
     artifact resolver or a spawn failure.

5. **Skill roots**
   - Confirm managed-skills reads `PROVIDER_SKILL_ROOTS` directly (Claude →
     `.claude/skills`, Codex/Pi → `.agents/skills`, etc.).

6. **Architecture guard**
   - Confirm the committed provider-boundary guard remains green: generic
     modules stay free of provider-literal switches, guard tokens derive from
     `RUNTIME_PROVIDER_IDS`, and live consumers use catalog helpers.

## Evidence

Useful evidence includes: package test output for the boundary/guard suites,
`daemon probe --json --no-upload` excerpts (redact host paths if needed), and a
short note that web setup copy matched the shared catalog for the sampled
providers.

## Expected Result

`PASS` means the revision keeps identity + composition-owned projections
intact across shared, client, CLI probe, and web setup surfaces, with no
provider-literal regression in the guarded generic modules.

`FAIL` means a generic module regained concrete provider branches/lists, web
reintroduced a parallel provider table, probe aggregation diverged from the
enabled provider set, skill-root / preference order drifted from catalog data,
or an in-product login lost a lifecycle step, leaked credential text, or
retained unbounded login output.

`BLOCKED` means the run cell could not exercise probe/UI surfaces for
environment reasons; record the gap and keep product-test evidence separate.
