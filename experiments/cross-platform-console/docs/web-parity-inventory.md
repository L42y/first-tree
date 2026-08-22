# Web console route inventory → mobile parity epics

Phase 0 exit-criteria artifact. Source of truth: `packages/web/src/app.tsx` route table
(full web console, not the `/m/*` PWA subset). Status legend: ✅ shipped · 🚧 partial · ⬜ not started ·
🚫 non-goal for the experiment.

## Core surfaces

| Web route | Epic | Status |
| --- | --- | --- |
| `/login` | OAuth sign-in (Google/GitHub, availability-aware) | ✅ |
| `/auth/complete`, `/auth/github/complete` | Token adoption via fragment interception | ✅ |
| Chats (index) | List + pinned section + ask-first sorting + dedupe | ✅ |
| Chat detail | Messages, markdown, cards, asks dock, avatars | ✅ |
| Team roster | Managed agents across orgs | ✅ |
| Agent detail | Read-only profile facts | ✅ (editing ⬜) |
| Settings | Profile / workspace / about / logout | 🚧 (org switching ⬜) |
| Context page | Context-tree write feed + windows | ✅ (read-only) |
| `/context/docs`, `/context/docs/:slug` | Docs list/read | ⬜ |

## Backlog epics (web features not yet ported)

1. **Workspace switching** — `/me/organizations` list → active-org swap (Settings).
2. **Agent management** — create/edit agents, runtime switching, suspend/reactivate.
3. **Computers/Clients** — `/me/clients` roster + status.
4. **Context docs** — docs list + reader.
5. **Repositories/GitHub/GitLab panels** — repo authorization flows.
6. **Invitations/templates/signup** — onboarding funnels.
7. **Notifications/command palette** — global actions.
8. **Resources & responsibilities pages**.

## Non-goals carried from the plan

- `/preview/*` styleguide gallery — web-only design tooling.
- `/m/*` Mobile Surface subset — superseded by this experiment.
- Porting Tailwind/Radix UI code — rebuilt natively instead.
