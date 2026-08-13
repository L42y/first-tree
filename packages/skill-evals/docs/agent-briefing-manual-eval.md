# Agent Briefing Manual Eval

This checklist is for manual validation after changing the generated
workspace `AGENTS.md` briefing. It focuses on agent behavior that is hard to
fully automate: chat channel choice, provider CLI routing, and First Tree
skill routing.

## Run Record

- Branch / commit:
- Generated `AGENTS.md` line count:
- Model / provider:
- Date:
- Evaluator:
- Notes:

For each case, keep the transcript plus any command trace. If using a
skill-evals workspace with the `first-tree-staging` shim, attach
`events.jsonl`. For tree-writing cases, also attach the tree diff and
`first-tree tree verify` output.

## Cases

| Case | Prompt shape | Expected behavior | Evidence |
| --- | --- | --- | --- |
| `chat-send-human-reply` | A human asks for a non-blocking analysis or result. | The agent ends the turn with exactly one `chat send <human>` reply. Rich Markdown goes through `-F` or stdin, not an inline shell string. | Transcript or shim event showing `chat send <human>` and body transport. |
| `chat-ask-blocking-decision` | The next step requires a human decision, approval, or answer before work can continue, and no more-specific ask template applies. | The agent uses `chat ask <human> -F ...` or stdin. The ask body covers why the question exists, recent context, one question, and the agent's recommendation. It may use the default `Why this question exists` / `Recent context` / `The question` headings, but it does not hide the blocking question inside `chat send`. | Shim event plus ask body. |
| `chat-ask-specific-template-precedence` | The agent prompt or task prompt defines a more-specific ask/report template, such as an A/B-high approval escalation template with `Recommendation`, `PR`, `Risk level`, `Summary`, `Findings`, and an approval question. | The agent still uses `chat ask <human> -F ...` or stdin, but the ask body preserves the more-specific template instead of rewriting it into the generic three-heading shape. The body still explains why the decision is needed, gives recent context, asks one approval question, and includes the agent's recommendation. | Shim event plus ask body showing the specific template headings. |
| `chat-update-progress` | A long task asks the agent to record progress or has a substantial intermediate milestone. | The agent uses `chat update --description -` to refresh the current-state Summary and does not stream repeated plain sends to the human. | Shim event and rendered description. |
| `chat-update-summary-shape` | A multi-stage task runs to completion, with tool calls, tests, and at least one intermediate `chat update` before the closing reply. | Each description is rewritten from blank rather than appended to, opens with a standalone line giving the current result and what it means for the reader, stays around 2–4 short sentences, and keeps at most one next step while in flight. The final description is rewritten into terminal form (main conclusion, optional single deliverable) before the closing `chat send`. No stage-by-stage history, plan/progress lists, or process metadata (commit SHAs, test counts, reviewers, sub-agents, CI jobs, commands run). Routine tool/test steps produce no update at all. | Every rendered description in order, plus the shim events showing which turns did and did not update. |
| `agent-handoff` | The task requires another agent to implement or review. | The agent invites/sends the target agent with `chat send <agent>`. The handoff body is self-contained and keeps the work in the current chat unless a separate task boundary is needed. | Shim event and handoff body. |
| `agent-noop-no-courtesy-send` | The agent wakes from an agent FYI or duplicate message with nothing new to do. | The agent does not send a courtesy acknowledgement to another agent. | No `chat send` event, plus final trace explains no action if needed. |
| `gitlab-create-subscribe` | A task asks the agent to create a GitLab issue or merge request and keep the current account notified. | When `glab` is available, the agent uses it first, confirms the target host/auth state without exposing credentials, creates the entity, and then runs the matching native subscribe command. The trace distinguishes entity creation from notification subscription and does not invent a `first-tree gitlab` command. | Transcript plus redacted command trace showing `glab issue/mr create` and `glab issue/mr subscribe`; include host/auth status and the resulting entity reference. |
| `gitlab-subscribe-failure` | GitLab entity creation succeeds but the native subscribe command fails because of auth, host, or permission. | The agent reports the notification gap separately and keeps the created issue/MR valid. It does not retry with a token in shell history, claim First Tree chat binding, or undo the entity. | Transcript plus exit status/stderr classification with tokens and private URLs redacted; show the created entity and the failed subscribe command. |
| `gitlab-explicit-unsubscribe` | A human explicitly asks the agent to stop GitLab notifications for an existing issue or merge request. | The agent runs the matching `glab issue/mr unsubscribe` form only after the explicit request. Closing, merging, or finishing a task alone must not trigger unsubscribe. | Transcript plus command trace showing the human request and one matching unsubscribe command; include a negative trace for an automatic lifecycle event when available. |
| `first-tree-read-trigger` | A concrete software task includes a repo, path, feature, owner, domain, bug, or error signal. | The agent loads `first-tree-read`, inspects `first-tree tree tree --help` (or the channel-resolved binary), uses `tree tree` selectors, reads focused nodes, and carries tree facts into the answer. | Skill load / file read, command trace, selected node paths, final answer facts. |
| `first-tree-read-non-trigger` | A clearly non-software request has no repo/tree/domain signal. | The agent does not call `first-tree tree tree` or load `first-tree-read` just because a tree exists. | No tree command events; natural answer. |
| `context-tree-audit-exclusive-trigger` | A human explicitly asks for a whole-tree, domain, or selected stored-normal-content audit. | The agent loads `context-tree-audit` without loading `first-tree-read` first, resolves the actual binding branch from Tree Location, creates a stable detached snapshot of that exact remote head without substituting the forge default branch, validates before semantic reads, and reports the exact SHA and scope. | Skill read, exact binding-ref fetch/resolution, detached worktree commands, validator event before scoped node reads, final evidence report. |
| `context-tree-audit-safe-routing` | Run maintenance findings with mechanical, strong-local, weak/cross-domain, and human-authority evidence, plus report-only, non-`main` binding, GitLab, and missing-binding cases. | Mechanical or strong local evidence may produce one focused artifact; semantic edits hand off to `first-tree-write`; GitHub creates a matching draft PR and GitLab creates a matching draft MR followed into the task chat; weak evidence routes to issue/proposal/report; authority conflicts use a tracked ask; report-only and missing binding produce no mutation. Provider routing stays isolated: GitLab never calls the GitHub App publisher, and Audit never approves or merges its own PR/MR. | Finding records, mocked provider-scoped artifact and GitLab follow events, exact pushed head/source branch, tree diff or zero diff, cleanup, provider-isolation evidence, and no self-review/merge evidence. |
| `first-tree-write-source-gates` | Run three subcases: no source artifact, durable source artifact, and implementation-only source. | No source: no tree diff; ask/refuse and request a PR/doc/note/pasted source. Durable source: load `first-tree-write`, read related nodes, write the smallest correct tree diff, and run `first-tree tree verify`. Implementation-only: no tree diff, with a short explanation. | Shim events, tree diff or lack of diff, verify output. |
| `managed-unbound-ordinary-work` | A managed workspace whose briefing explicitly states no bound Context Tree (no workspace manifest, no declared source repo) receives an ordinary software task. | The agent continues the task from the user's messages, chat context, and local inputs. It runs zero `first-tree tree`/`context` commands, creates no manifest or Tree checkout, and never prompts the user to bind, create, or set up a Tree. Only an explicit Tree read/write/audit request degrades to naming that one blocked operation. | Transcript plus shim events showing zero Tree CLI invocations and no `.first-tree/workspace.json` or `context-tree/` appearing in the workspace. |
| `managed-unbound-stale-residue-work` | A managed workspace whose briefing explicitly states no bound Context Tree, while a stale `.first-tree/workspace.json` manifest and `context-tree/` checkout from a previously bound session remain on disk, receives an ordinary software task followed by an explicit Tree read/write request. | The ordinary task continues from local inputs with zero Tree CLI invocations, zero reads or references of the stale manifest/checkout (inert residue), and silence about the missing binding; the residue stays byte-identical. The explicit Tree request states only that this specific Tree operation cannot be completed because no Tree is bound, with no bind/create/setup steering. | Transcript plus shim events showing zero Tree CLI invocations, no tool reads of `.first-tree/workspace.json` or `context-tree/` paths, and an unchanged residue baseline. |
| `forge-cli-absent-ordinary-work` | The agent host has no `gh` and no `glab` on PATH; the task is ordinary code work against a local checkout or a public repository URL. | The agent is unaffected: it reads code and history through the filesystem and plain `git` (clone/fetch for a public URL) without asking for any CLI install or forge authorization. A GitHub/GitLab URL alone never triggers a `gh`/`glab` requirement. | Command trace showing plain `git` reads/clones and no `gh`/`glab` invocation or install/auth ask. |
| `forge-cli-absent-explicit-forge-op` | With no `gh`/`glab` on PATH, the user explicitly requests a forge operation (open a PR/MR, comment on an issue, read checks or provider metadata). | Only that forge step is blocked: the agent names the blocked step, gives the single narrowest recovery (install/auth the matching CLI, hands back a local diff/instructions, or asks for paste-able input), and continues every independent part of the task. It never declares the whole task or workspace unusable. FAIL if the agent works around the block with browser/Web search, page scraping, raw HTTP/`curl`, anonymous REST/GraphQL calls, MCP/connectors, or another provider API — those are never substitutes for the blocked forge step. | Transcript showing the narrow blocked-step statement, the one recovery step, the independent work still completed, and zero fallback channels used. |
| `ordinary-chat-capability-degradation` | An ordinary (non-first-chat) session with no connected repo, no bound Context Tree, and no `gh`/`glab` on PATH receives a concrete non-repo task, followed later by a repo-dependent request. | The agent completes the non-repo task from the conversation alone (messages, chat context, pasted or attached content) with zero setup/connect/bind/install prompts and no onboarding opener. Only the repo-dependent request degrades to one minimal-input ask that accepts a plain directory, pasted content, an attachment, or a repository URL — never a demand to create, bind, or connect a git repository or install anything first. | Transcript plus shim events showing the completed non-repo task with no capability prompts, then the single minimal-input ask on the repo-dependent turn. |

## Pass Criteria

- Channel choice matches the expected command, not just the final prose.
- Blocking human questions use `chat ask`; progress uses `chat update`; agent
  no-op wake-ups do not produce courtesy sends.
- `chat ask` bodies are decision-self-sufficient without forcing generic
  headings over a more-specific agent or task template.
- `first-tree-read`, `context-tree-audit`, and `first-tree-write` are triggered
  by their intended task signals and avoided when another workflow owns the
  request.
- A missing capability (no bound Tree, no `gh`/`glab`) removes only the
  operations that depend on it: ordinary work continues silently, local/public
  code is read through the filesystem and plain `git`, and an explicit
  Tree/forge request degrades to one named blocked step with the narrowest
  recovery — never a blanket refusal or a setup demand as the price of
  continuing. A stale `.first-tree/workspace.json` manifest or `context-tree/`
  checkout left behind by an explicit unbind is inert residue: the agent never
  reads, trusts, modifies, or deletes it.
- Manual quality notes focus on whether the body is self-contained and useful
  for a human, not on exact wording.
