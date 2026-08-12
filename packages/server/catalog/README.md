# Official Agent Template catalog

`official-agent-templates.json` is the reviewed source for the three OpenTag
launch Templates. Each entry is a strict `CreateAgentTemplate` payload and is
validated by shared contract tests before it can be published.

Publishing uses the existing governed catalog API. The access JWT must belong
to a current active admin of the deployment's configured
`FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID`; the server rechecks that
membership and optimistic-concurrency token for every mutation.

Provide `FIRST_TREE_SERVER_URL` and `FIRST_TREE_ACCESS_TOKEN` through the
deployment's secret-aware environment or credential runner before invoking
the command. Do not paste the access token into a shell command or history.

Preview the reconciliation first:

```bash
pnpm --filter @first-tree/server agent-templates:publish
```

Apply the reviewed definitions:

```bash
pnpm --filter @first-tree/server agent-templates:publish -- --apply
```

The publisher creates and publishes missing definitions, updates changed
active definitions, and publishes matching drafts. It does not retire unrelated
Templates and fails closed if a launch slug is already retired.
