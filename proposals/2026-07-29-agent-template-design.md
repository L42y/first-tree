# Agent Templates: Minimal V1 Design

**Status:** Implemented on `feat/agent-templates`
**Date:** 2026-07-29

## Product contract

V1 provides one official online Template catalog. A Template contains:

- a title, summary, and expected outcomes for browsing;
- one managed Custom Instructions fragment;
- references to existing official Team Skill and MCP Resources.

An Agent may use an ordered list of zero to eight Templates. The same list can
be supplied while creating an Agent or replaced later through the Agent
configuration API.

Templates are live references, not copies. Updating a Template or one of its
Resources updates every Agent that uses it through the existing config version
and notification mechanism. The Agent's own editable Custom Instructions remain
a separate layer and are never overwritten.

V1 intentionally has no Template snapshots, installation rows, version history,
marketplace, categories, tags, or per-Agent Template overrides.

## User experience

### New Agent

New Agent contains one compact line:

```text
Template · <selected Template titles>                         Browse
```

It is not a card. Browse opens the dedicated Template page and returns the
ordered selection to the same New Agent flow. Create remains the only final
creation action.

### Template browser

The browser uses:

- a compact title and explanatory line;
- a top-right continuation action;
- a left Template list and right Template detail;
- no tags or filter controls in V1.

The detail explains the Template's value, outcomes, Custom Instructions,
Skills, and MCP integrations. There is no secondary “start from scratch”
action at the bottom.

The top-right action supports both entry paths:

- from New Agent with no selection: **Continue without a template**;
- direct entry with no selection: **Create an agent without a template**;
- with a selection: **Use this template** or **Use N templates**.

### Official management

One configured publisher Team owns the online catalog. Its current admins may
create, update, order, and retire Templates through the management API. V1
keeps this as an operator/admin workflow; it does not add a second end-user
authoring surface.

Any active member of another Team may browse the public projection. That
projection includes the information needed to choose a Template but excludes
Resource IDs, attachment IDs, MCP commands, and MCP endpoints.

## Minimal data model

Only one new table and one new Agent configuration field are required.

### `agent_templates`

```sql
create table agent_templates (
  id text primary key,
  organization_id text not null,
  version integer not null default 1,
  title text not null,
  summary text not null,
  outcomes text[] not null default '{}',
  custom_instructions text not null,
  resource_ids text[] not null default '{}',
  status text not null default 'active',
  sort_order integer not null default 0,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`id` is an immutable, globally unique kebab-case slug. `version` is a
compare-and-swap counter for admin writes, not Template history.

`resource_ids` is one array rather than separate Skill and MCP arrays.
`resources.type` already identifies the kind, so separate fields would create
unnecessary synchronization rules.

The table deliberately has no foreign keys. Template writes validate and lock
the referenced Resource rows in the same transaction.

### `agent_configs.template_ids`

```sql
alter table agent_configs
  add column template_ids text[] not null default '{}';

create index idx_agent_configs_template_ids
  on agent_configs using gin (template_ids);
```

The array is the complete ordered selection. A relation table is unnecessary
because a selection has no metadata of its own. The GIN index supports the
reverse lookup needed when a live Template update fans out to affected Agents.

## Validation rules

A Template may reference only Resources that:

- belong to the configured publisher Team;
- have Team scope and active status;
- are either Skill or MCP Resources;
- have a valid Resource payload;
- for Skills, reference a ready complete bundle attachment;
- for MCP, use the existing no-secret MCP schema.

Resource IDs must be unique. Official Templates may reuse the same Resource.
Different official MCP Resources may not claim the same runtime name; if
Templates share an MCP name, they must share the same Resource.

An Agent selection:

- preserves submitted order;
- contains unique Template IDs;
- contains at most eight Templates;
- accepts only official active Templates when creating or newly adding;
- may retain an already-selected retired Template until it is removed.

Human identity mirrors cannot use Templates.

## API

### Browse

```http
GET /api/v1/orgs/:orgId/agent-templates
```

The route requires active membership in `:orgId` and returns active Templates
from the configured publisher Team in `sort_order, id` order.

### Manage the official catalog

```http
POST   /api/v1/orgs/:orgId/agent-templates
GET    /api/v1/agent-templates/:templateId
PATCH  /api/v1/agent-templates/:templateId
DELETE /api/v1/agent-templates/:templateId
```

Creation requires an admin of the configured publisher Team. Full definition
reads require publisher Team membership; mutation requires its admin role.
PATCH and DELETE carry `expectedVersion`. DELETE is a soft retirement and is
idempotent once the expected current retired version is supplied.

### Configure one Agent

```http
GET   /api/v1/agents/:agentId/templates
PATCH /api/v1/agents/:agentId/templates
```

PATCH replaces the complete ordered list:

```json
{
  "expectedVersion": 7,
  "templateIds": ["research-assistant", "release-manager"]
}
```

It uses the Agent's existing manager/admin authorization and the existing
`agent_configs.version` compare-and-swap counter.

### Create an Agent

The existing endpoint accepts the optional ordered list:

```http
POST /api/v1/orgs/:orgId/agents
```

```json
{
  "name": "researcher",
  "type": "agent",
  "templateIds": ["research-assistant"]
}
```

Template validation, Agent insertion, and initial Agent config insertion occur
in the same transaction. Invalid or retired Template input creates nothing.

## Runtime composition

The existing Resource resolver owns runtime composition. It loads the selected
Templates and their official Resources while resolving the Agent's effective
configuration.

Prompt order is deterministic:

1. Team prompt Resources;
2. Template Instructions in stored Template order;
3. Agent-specific prompt fragments.

Template Instructions are projected as managed, non-editable sections. The
Agent's standalone Custom Instructions remain the only prompt fragment the
Agent can edit about itself.

Skill and MCP composition uses existing Resource projection:

- the same Resource ID is included once across Team configuration and all
  Templates;
- Template Skills use the same Team Skill projection and Managed Skills
  reconciliation as ordinary Team Skills;
- the consumer Team's enabled MCP Resource wins when it has the same runtime
  name as an official Template MCP;
- Template MCPs that lose that resolution remain explainable as replaced.

Templates do not introduce a separate Skill installer, update channel, MCP
store, or secret model.

## Live updates and retirement

Updating a Template:

1. locks and validates the Template and referenced Resources;
2. commits the change with its Template version incremented;
3. increments `agent_configs.version` for every affected Agent;
4. records `updated_by = system` for affected Agents outside the publisher
   Team;
5. sends the existing per-Agent config-change notification.

Updating a referenced Resource follows the same affected-Agent fan-out.

A referenced Resource cannot be retired or made stale until every Template
reference is removed. Retiring a Template:

- hides it from the catalog;
- blocks new selection;
- preserves the live definition for Agents that already use it;
- does not recycle its slug.

## Configuration and rollout

The catalog is enabled by:

```text
FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID=<publisher organization id>
```

Leaving it unset returns an empty catalog and disables Template mutation.

Rollout requires migration `0090_dizzy_mesmero.sql`, configuring the
publisher Team, and creating its Templates from existing complete Skill and
no-secret MCP Resources.

## Explicitly deferred

- customer-authored or personal Templates;
- Template tags, categories, filters, search, and pagination;
- Template snapshots, rollback, pinning, or approval workflows;
- copying Template content into an Agent;
- per-Agent edits inside a Template;
- repositories, environment variables, runtime provider, model, or computer
  configuration in Templates;
- MCP credentials or secret headers;
- a Web authoring UI for the official publisher Team.
