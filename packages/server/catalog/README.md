# Official Agent Template catalog

`official-agent-templates.json` is the reviewed source for the three OpenTag
launch Templates. Each entry is a strict `CreateAgentTemplate` payload and is
validated by shared contract tests before it can be published.

Publishing uses the existing governed catalog API. The access JWT must belong
to a current active admin of the deployment's configured
`FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID`; the server rechecks that
membership and optimistic-concurrency token for every mutation.

Preview the reconciliation first:

```bash
FIRST_TREE_SERVER_URL=https://example.com \
FIRST_TREE_ACCESS_TOKEN=<publisher-member-jwt> \
pnpm --filter @first-tree/server agent-templates:publish
```

Apply the reviewed definitions:

```bash
FIRST_TREE_SERVER_URL=https://example.com \
FIRST_TREE_ACCESS_TOKEN=<publisher-member-jwt> \
pnpm --filter @first-tree/server agent-templates:publish -- --apply
```

The publisher creates and publishes missing definitions, updates changed
active definitions, and publishes matching drafts. It does not retire unrelated
Templates and fails closed if a launch slug is already retired.
