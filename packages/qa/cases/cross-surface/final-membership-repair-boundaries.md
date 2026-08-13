---
id: final-membership-repair-boundaries
description: Validate that losing the final active Team membership repairs only within self-service authority and otherwise stops at an invitation boundary.
areas: [cross-surface]
surfaces: [server, web]
---

# Final Membership Repair Boundaries

## Goal

Confirm that an authenticated human cannot continue into a normal Team workspace
without a live membership, while preserving the deployment's authority model:

- a normal self-service deployment converges final membership loss to one safe
  personal Team;
- an invitation-only deployment creates no Team and presents an explicit
  invitation or sign-in boundary until an authorized membership exists;
- users who still have another active membership keep that Team and their Web
  selection semantics;
- live membership, not an access token or a remembered Team selection, remains
  the authority for `/me`, refresh, and Team-scoped requests.

Stable concurrency and response contracts belong in server and Web product
tests. This case owns the live cross-surface behavior: browser navigation,
session clearing or recovery, and the identity and managed-agent effects visible
after real self-leave or admin removal.

## Preconditions

- Validate an exact target revision in task-owned data. Prepare separate
  self-service and invitation-only server configurations; the latter must set
  the configured allowed Team and must not expose self-service Team creation.
- Prepare a single-Team user, a multi-Team user, an administrator who can remove
  another member, and a member who manages a non-human agent. Record stable
  user, membership, Team, human-mirror, and managed-agent IDs without recording
  auth tokens or provider identifiers.
- Keep at least one other administrator in a Team before testing admin removal
  or managed-agent reassignment. Physical Team deletion and account
  deletion/reactivation are not current product routes; probe that boundary
  only to confirm it fails closed, not by mutating the database to imitate an
  unsupported product action.

## Scenarios

1. In self-service mode, leave the user's only Team from the Web Team menu.
   Verify the departed membership and its human mirror are retained as inactive
   history, exactly one active personal-Team membership exists afterward, and
   the browser never renders the departed Team workspace during navigation.
   Refresh the page and verify `/me` resolves to the repaired membership.
2. Have an administrator remove another user's final membership. With the
   target's existing browser session still open, verify the old Team becomes
   inaccessible immediately and the target converges to one repaired Team.
   Verify the old human mirror is suspended, its display identity is retained,
   managed agents are unpinned and reassigned to the fallback administrator,
   and no agent or membership history is deleted.
3. Repeat self-leave and admin removal for a user who has another active Team.
   Verify no personal Team is created, the remaining membership is unchanged,
   and a remembered selected Team falls back only when that selection is no
   longer backed by a live membership.
4. Exercise simultaneous loss of the final two memberships and retry the final
   leave/removal request. Verify the account converges to exactly one personal
   Team and duplicate retries do not create additional Teams or human mirrors.
   Start an additional-Team creation request before the loss transaction and
   verify it cannot borrow the repaired membership as retroactive authority;
   after refreshing membership state, a newly started request may create an
   additional Team normally.
5. In invitation-only mode, repeat final self-leave and admin removal. Verify no
   personal Team or active human mirror is created, `/me` and token refresh
   return the invitation boundary, and the browser clears normal Team state and
   shows retry/sign-out recovery instead of mounting Team-scoped pages. For the
   self-left row, accept a valid invitation for the allowed Team and verify the
   same membership and human-mirror IDs reactivate before navigation resumes.
   For the admin-removed row, verify the same invitation stops at the explicit
   administrator-restore boundary without redemption; have an administrator
   restore that stable row, then verify membership-backed navigation resumes.
6. Create or locate an unexpected legacy account with zero active memberships.
   In self-service mode, verify password, OAuth, connect-token, or refresh
   re-entry repairs once and then `/me` exposes only the new live membership.
   In invitation-only mode, verify each re-entry path stays at the invitation
   boundary with no Team side effects. A suspended account must stay closed;
   only after explicit reactivation may the applicable repair policy run.
7. Probe unsupported physical lifecycle routes for Team deletion/reactivation
   and account deletion/reactivation. Verify they remain unavailable and do not
   change memberships, users, Teams, or identity mirrors.

## Evidence

A credible result includes the deployment mode, exact target, before/after
membership and Team IDs, `/me` and refresh statuses, browser destination, and
the old/new human-mirror plus managed-agent ownership states. For concurrency,
show the initiating order and final cardinalities rather than relying only on
two successful HTTP responses. For invitation-only checks, include evidence
that no organization or active membership was inserted.

## Result Rules

- `PASS` requires every exercised Team-scoped surface to be backed by a live
  membership and no hidden Team creation in invitation-only mode.
- A duplicate personal Team, stale Team workspace render, identity deletion,
  orphaned managed agent, or token/selection-based authorization is `FAIL`.
- Missing invitation configuration, inability to create task-owned lifecycle
  fixtures, or unavailable browser/session evidence is `BLOCKED` for the
  affected scenario rather than evidence that the boundary passed.
