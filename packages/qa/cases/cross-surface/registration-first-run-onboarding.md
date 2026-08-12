---
id: registration-first-run-onboarding
description: Validate that a brand-new user may remain Team-less after authentication and creates the first Team only at an explicit Agent-start boundary.
areas: [cross-surface]
surfaces: [server, web]
---

# Registration And First-Agent Entry

## Goal

Confirm the current first-run lifecycle for a genuinely new identity:

- authentication creates the user account but no Team, membership, or human mirror;
- ordinary browsing and Template discovery remain write-free;
- an explicit Template confirmation creates the Team, Admin membership, human
  mirror, unbound organization-visible Team Agent, and Template adoption in one
  transaction;
- a known landing-campaign Quickstart instead creates the Team and
  service-managed trial Agent atomically, then opens its trial chat;
- a campaign action that needs the user's own Agent preserves its handoff and
  routes a Team-less caller through first-Agent selection, never into a hosted
  trial;
- Account and Sign out remain reachable while the user has no Team.

This case owns the cross-surface behavior that deterministic auth, provisioning,
rollback, and route tests cannot prove in one real browser journey. Runtime
binding/readiness after an unbound Team Agent exists is a separate journey.

## Preconditions

- A disposable stack whose database can be inspected.
- A previously unseen identity. Use real OAuth or the localhost-only GitHub dev
  callback with its explicit non-production gate; never expect that callback in
  a deployed environment.
- At least one active public Agent Template.
- For the Quickstart branch, a configured official campaign Runtime.

## Scenario A — Template confirmation

1. Sign in with the unseen identity. Verify `/me` is authoritative with zero
   active memberships and that no organization, membership, or human mirror was
   created for the user.
2. Browse the Template library, reload it, and open Account. Verify the database
   remains unchanged and the user menu supports Sign out.
3. Choose one Template and confirm **Create Team Agent**. Verify one transaction
   creates exactly one Team, active Admin membership, matching human mirror,
   unbound organization-visible Agent, adopted Template configuration, Team
   Resources, and bindings.
4. Verify the browser opens the new Agent continuation and does not enter the
   standalone Admin onboarding or show the legacy Team naming step. The
   membership suppresses that legacy auto-open without marking Runtime setup as
   complete. Revisit `/onboarding` and Settings → Setup: neither direct entry nor
   an advertised Resume action may reopen the Team naming / duplicate-Agent flow.
5. Repeat the same request identity and verify it resolves the same Team and
   Agent. Submit a different request identity or intent and verify it conflicts
   rather than impersonating a retry. Race two identical confirmations and
   verify one Team and Agent exist.
6. Force Template adoption to fail and verify no Team, membership, mirror,
   Agent, Resource, or binding survives.

## Scenario B — known Quickstart

1. Sign in through a preserved known `/quickstart` return URL with another new
   identity. Verify the browser reaches Quickstart rather than the generic
   Team-less Template redirect.
2. Start the trial without an organization selector. Verify Team, caller Admin
   membership and human mirror, tenant-local service membership, and managed
   trial Agent commit together before chat bootstrap.
3. Race/retry the same campaign and repository. Verify one Team, one trial
   Agent, and one keyed trial chat.
4. Repeat on an invitation-only deployment and verify the Team-less start is
   refused without partial rows.

## Scenario C — campaign action

1. Open a configured campaign action URL as a new Team-less user. Verify it does
   not call the trial-start endpoint, stores only the validated handoff, and
   routes to Template selection instead of the org-scoped legacy onboarding
   route.
2. Confirm a Template. Verify the first Team Agent is created atomically and the
   stored action remains available for the later Runtime/setup continuation.
3. Re-open the action after the user's Agent is connectable. Verify one task chat
   is created or reused and the handoff clears only after that chat exists.

## Legacy Cohort Preservation

Exercise an existing membership still routed to standalone onboarding. Verify
its Team selection, connect-computer, Agent creation/readiness, kickoff chat,
and completion stamps retain their prior behavior. The new user-scoped first-
Team endpoint must not create another Agent or Team for this cohort.

## Evidence

Keep redacted completion URLs, relevant `/me` projections and network calls,
stable resource IDs, browser-visible Account/Sign-out access, and database row
counts before and after each atomic boundary. Never retain OAuth codes, tokens,
cookies, provider subjects, private repository contents, or report keys.

## Result Rules

`PASS` requires all executed branches to preserve the declared zero-Team and
atomicity boundaries with no duplicate or partial resources. `FAIL` includes an
empty Team at sign-in, a post-confirmation redirect into legacy Team naming, a
dropped Quickstart/action handoff, a false retry, a duplicate first Team/Agent,
or loss of Account/Sign-out access. `BLOCKED` means the required fresh identity,
Template, official Runtime, or database visibility is unavailable.
