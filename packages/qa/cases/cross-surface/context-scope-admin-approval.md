---
id: context-scope-admin-approval
description: Validate active-admin Context Reviewer ownership and exact-head tracked approval for every root SCOPE change.
areas: [cross-surface]
surfaces: [server, context-tree, github, gitlab, chat]
---

# Context SCOPE Admin Approval

## Goal

Prove that routing authority cannot change through automatic review alone. Every
root `SCOPE.md` add/edit/delete/rename must be approved by the Context
Reviewer's current same-Team active-admin manager for the exact final head.

## Preconditions

- Prepare disposable GitHub and GitLab Trees, an active admin-managed Reviewer,
  an ordinary-member-managed Agent, and an admin that can be demoted/revoked.
- Prepare SCOPE add, body/frontmatter edit, delete, case/path rename, and
  unrelated-node-only PR/MR fixtures.
- Use the real webhook-created Review Chat and tracked question surface.

## Operate

1. Verify the ordinary-member-managed Agent is absent from Reviewer candidates
   and cannot be assigned/enabled through direct API calls.
2. Dispatch every SCOPE mutation. Confirm the Reviewer does not repair,
   approve, publish or merge before a tracked ask to its manager.
3. Inspect the ask: Team, forge artifact, exact head, digest, full proposed body
   or deletion state, and one approval question must be present.
4. Reject once and confirm the run stops. Approve a fresh run and confirm it
   resumes only at the same head/digest.
5. Push a new head before and after approval; change SCOPE and change only an
   unrelated file. Confirm any head change invalidates the approval and asks
   again against the new final head.
6. Demote/remove the manager before creating the ask and while waiting for its
   answer. Confirm ask creation or answer consumption fails closed until the
   same manager is again an active Admin; no manager is silently substituted.
7. After an Admin answer has been consumed for an unchanged exact head/digest,
   demote that manager. Confirm the already-consumed exact-head decision remains
   valid and ordinary review publication/merge keeps its existing authority
   gates rather than introducing a new manager-role gate.
8. Run an unrelated normal-node PR/MR and confirm it follows ordinary Reviewer
   behavior without a SCOPE approval ask.

## Expected Result

`PASS`: candidate selection, assignment and enablement enforce active-admin
management; ask creation and answer consumption recheck that exact manager;
every SCOPE mutation has one valid exact-head admin approval; and ordinary
repair/publication/merge do not add a manager-role gate after that decision.

`FAIL`: member-managed Reviewer authority is accepted, a chat participant can
approve instead of the current admin manager, approval survives head/authority
change, or the Reviewer edits SCOPE itself.

`BLOCKED`: webhook routing, tracked asks, disposable forge repositories or an
admin/member fixture cannot be prepared.

`INCONCLUSIVE`: only Skill text or mocked Server behavior is inspected.

## Evidence

Keep candidate/readiness responses, Review Chat memberships, tracked question
ids and resolutions, manager roles at every gate, exact heads/digests, review
publication/merge records and forge audit links.
