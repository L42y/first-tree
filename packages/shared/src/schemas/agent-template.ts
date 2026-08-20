import { z } from "zod";
import { findAssembledBriefingFingerprint } from "../agent-briefing-guard.js";
import {
  mcpHttpServerSchema,
  mcpSseServerSchema,
  mcpStdioServerSchema,
  runtimeSkillBundleSchema,
} from "./agent-runtime-config.js";
import {
  agentResourceBindingInputSchema,
  effectiveAgentResourcesSchema,
  PROMPT_RESOURCE_BODY_MAX_CHARS,
  promptResourcePayloadSchema,
  resourceRowSchema,
  skillResourcePayloadSchema,
} from "./resource.js";

/**
 * Official Agent Template domain contract (schema/persistence only).
 *
 * A Template is a global, official one-shot starting configuration. When a
 * user adopts a Template, its components are imported into the adopting
 * Team's Resources; after import the Team Resources are the execution
 * authority and V1 never syncs later Template changes into existing Teams.
 */

/**
 * Stable HTTP error codes for Agent create / Template adoption conflicts.
 * Routes return `{ error, code }` so Web can branch without sniffing message
 * text — name collisions, version-CAS, adoption conflicts, and inactive
 * Agents must not share a single 409 recovery path.
 */
export const AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES = {
  NAME_CONFLICT: "agent_name_conflict",
  VERSION_CONFLICT: "agent_templates_version_conflict",
  ADOPTION_CONFLICT: "agent_template_adoption_conflict",
  AGENT_INACTIVE: "agent_templates_agent_inactive",
} as const;
export type AgentTemplateLifecycleErrorCode =
  (typeof AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES)[keyof typeof AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES];

export const AGENT_TEMPLATE_STATUSES = {
  DRAFT: "draft",
  ACTIVE: "active",
  RETIRED: "retired",
} as const;

export const agentTemplateStatusSchema = z.enum(["draft", "active", "retired"]);
export type AgentTemplateStatus = z.infer<typeof agentTemplateStatusSchema>;

/** An Agent may adopt 0-3 Templates. The set carries no order or priority. */
export const MAX_AGENT_TEMPLATE_IDS = 3;

/**
 * Template ids normalize to lowercase before validation so that mixed-case
 * spellings of the same UUID cannot bypass uniqueness checks or produce
 * divergent sort/storage text.
 */
export const agentTemplateIdSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().uuid());
export type AgentTemplateId = z.infer<typeof agentTemplateIdSchema>;

/**
 * Agent Template selection set: 0-3 distinct Template ids, normalized to a
 * canonical sorted order so array position never expresses priority.
 */
export const agentTemplateIdsSchema = z
  .array(agentTemplateIdSchema)
  .max(MAX_AGENT_TEMPLATE_IDS)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Template ids must be unique.",
        });
      }
      seen.add(id);
    }
  })
  .transform((ids) => [...ids].sort());
export type AgentTemplateIds = z.infer<typeof agentTemplateIdsSchema>;

/**
 * Stable key identifying one importable component inside a Template. Used by
 * Team Resource / binding provenance (`origin_component_key`) to deduplicate
 * imports and to attribute auto-created bindings.
 */
export const AGENT_TEMPLATE_COMPONENT_KEY_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const agentTemplateComponentKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(AGENT_TEMPLATE_COMPONENT_KEY_REGEX, "Component keys must be lowercase kebab-case.");
export type AgentTemplateComponentKey = z.infer<typeof agentTemplateComponentKeySchema>;

const agentTemplateComponentBaseShape = {
  key: agentTemplateComponentKeySchema,
  name: z.string().min(1).max(200),
} as const;

/** Prompt component: imports as a Team Prompt Resource. */
export const agentTemplatePromptComponentSchema = z
  .object({
    ...agentTemplateComponentBaseShape,
    type: z.literal("prompt"),
    // Strict-ify the reused Resource payload without copying it: the Template
    // canonical payload (and its future digest) must not silently strip
    // unknown nested fields.
    payload: promptResourcePayloadSchema.strict().superRefine((payload, ctx) => {
      // Templates are another managed prompt-ingestion path, so the shared
      // generated-briefing hard guard applies exactly as it does to
      // server-side prompt writes (conclusive marker tier only).
      const fingerprint = findAssembledBriefingFingerprint(payload.body);
      if (fingerprint?.kind !== "generated-marker") return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: `Prompt body contains the generated-briefing marker "${fingerprint.match}".`,
      });
    }),
  })
  .strict();
export type AgentTemplatePromptComponent = z.infer<typeof agentTemplatePromptComponentSchema>;

/**
 * Skill component: imports as a Team attachment + Skill Resource. `payload`
 * carries the derived inline fields and `bundle` references the immutable
 * complete-directory ZIP (SKILL.md plus supporting files), reusing the exact
 * runtime bundle descriptor used by Team Skills.
 */
export const agentTemplateSkillComponentSchema = z
  .object({
    ...agentTemplateComponentBaseShape,
    type: z.literal("skill"),
    // Strict-ified for the same reason as the prompt payload above.
    payload: skillResourcePayloadSchema.strict(),
    bundle: runtimeSkillBundleSchema,
  })
  .strict();
export type AgentTemplateSkillComponent = z.infer<typeof agentTemplateSkillComponentSchema>;

/**
 * Template MCP secret boundary. Templates are global content imported into
 * arbitrary Teams, so their MCP definitions must not carry anything that
 * could smuggle a credential across that boundary: no URL credentials, no
 * URL query/fragment data, and no stdio command arguments. This is a
 * Template-specific tightening — stricter than the Resource no-secret
 * contract, which still permits query/fragment data and stdio arguments.
 */
function hasNoTemplateMcpUrlData(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL: the built-in z.string().url() check reports that failure.
    // Refinements still run after a failed built-in check, so this function
    // must stay exception-safe and never turn safeParse into a throw.
    return true;
  }
  return parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "";
}

const TEMPLATE_MCP_URL_MESSAGE = "Template MCP URLs must not include credentials, query, or fragment data.";

/**
 * Bounded envelope for Template MCP URLs and stdio commands. 8 KiB is loose
 * for any real executable path or query/fragment-free endpoint, and makes
 * the Template write contract provably finite (see
 * AGENT_TEMPLATE_WRITE_BODY_LIMIT). Runtime schemas stay uncapped; this is
 * Template-specific.
 */
export const AGENT_TEMPLATE_MCP_STRING_MAX = 8 * 1024;

/**
 * Template HTTP/SSE variants derive from the runtime schemas so the
 * canonical MCP name pattern/message has exactly one source. `headers` is
 * omitted (a secret channel), and the URL gains the Template no-secret
 * refine plus the bounded envelope.
 */
const agentTemplateMcpHttpServerSchema = mcpHttpServerSchema
  .omit({ headers: true })
  .extend({
    // Reuse the runtime URL validity, then add the Template cap and the
    // no-secret refine — one source for the base rules.
    url: mcpHttpServerSchema.shape.url
      .max(AGENT_TEMPLATE_MCP_STRING_MAX)
      .refine(hasNoTemplateMcpUrlData, TEMPLATE_MCP_URL_MESSAGE),
  })
  .strict();

const agentTemplateMcpSseServerSchema = mcpSseServerSchema
  .omit({ headers: true })
  .extend({
    url: mcpSseServerSchema.shape.url
      .max(AGENT_TEMPLATE_MCP_STRING_MAX)
      .refine(hasNoTemplateMcpUrlData, TEMPLATE_MCP_URL_MESSAGE),
  })
  .strict();

const agentTemplateMcpStdioServerSchema = mcpStdioServerSchema
  .extend({
    command: mcpStdioServerSchema.shape.command.max(AGENT_TEMPLATE_MCP_STRING_MAX),
    // Arguments are the stdio secret channel (--token=...); Templates must
    // not carry any.
    args: z.array(z.string()).max(0).optional(),
  })
  .strict();

export const agentTemplateMcpServerSchema = z.discriminatedUnion("transport", [
  agentTemplateMcpStdioServerSchema,
  agentTemplateMcpHttpServerSchema,
  agentTemplateMcpSseServerSchema,
]);
export type AgentTemplateMcpServer = z.infer<typeof agentTemplateMcpServerSchema>;

/** MCP component: imports as a Team MCP Resource. Secrets are not allowed. */
export const agentTemplateMcpComponentSchema = z
  .object({
    ...agentTemplateComponentBaseShape,
    type: z.literal("mcp"),
    payload: agentTemplateMcpServerSchema,
  })
  .strict();
export type AgentTemplateMcpComponent = z.infer<typeof agentTemplateMcpComponentSchema>;

/** Repo components are deliberately not part of the Template contract. */
export const agentTemplateComponentSchema = z.discriminatedUnion("type", [
  agentTemplatePromptComponentSchema,
  agentTemplateSkillComponentSchema,
  agentTemplateMcpComponentSchema,
]);
export type AgentTemplateComponent = z.infer<typeof agentTemplateComponentSchema>;

/** Public example-task copy is deliberately small enough for catalog cards and handoff surfaces. */
export const MIN_AGENT_TEMPLATE_EXAMPLE_TASKS = 2;
export const MAX_AGENT_TEMPLATE_EXAMPLE_TASKS = 3;
export const MAX_AGENT_TEMPLATE_EXAMPLE_TASK_CHARS = 300;

/**
 * Public-safe profile: the only Template data a public/marketing surface may
 * ever serialize. Raw instructions, bundle references, and MCP connection
 * details live in `components` and must never leak through this section.
 */
export const agentTemplatePublicProfileSchema = z
  .object({
    /** One-line value proposition. */
    tagline: z.string().min(1).max(200),
    /** What kind of work this Template is for. */
    purpose: z.string().min(1).max(2000),
    /** Who this Template is for. */
    targetUsers: z.string().min(1).max(1000),
    /** The concrete user benefit of adopting it. */
    userValue: z.string().min(1).max(2000),
    /** Summary of the guidance the Template adds (never the raw body). */
    instructionsSummary: z.string().max(2000),
    /** Summary of the tools and skills the Template adds. */
    toolsAndSkillsSummary: z.string().max(2000),
    /** Concrete, public-safe work examples. Optional for payload compatibility. */
    exampleTasks: z
      .array(z.string().min(1).max(MAX_AGENT_TEMPLATE_EXAMPLE_TASK_CHARS))
      .min(MIN_AGENT_TEMPLATE_EXAMPLE_TASKS)
      .max(MAX_AGENT_TEMPLATE_EXAMPLE_TASKS)
      .optional(),
  })
  .strict();
export type AgentTemplatePublicProfile = z.infer<typeof agentTemplatePublicProfileSchema>;

/** Maximum number of importable components in one Template. */
export const MAX_AGENT_TEMPLATE_COMPONENTS = 100;

/**
 * Route-level JSON body limit for the Template write endpoints, sized from
 * the accepted contract. The dominant term is the Prompt worst case: up to
 * MAX_AGENT_TEMPLATE_COMPONENTS components, each with a
 * PROMPT_RESOURCE_BODY_MAX_CHARS body, at 6x — the worst JSON escape
 * inflation for PostgreSQL-persistable control characters such as
 * U+0001, which requires a six-byte JSON escape (actual U+0000 is rejected
 * by the Template text contract below). The 4x factor used for documents
 * only covers common UTF-8 and would undercut legal Template payloads
 * (~19.8 MiB). The 2 MiB headroom covers every other bounded write-source
 * string (slugs, names, descriptions, component keys, the public profile,
 * and MCP names/URLs/commands capped at AGENT_TEMPLATE_MCP_STRING_MAX) plus
 * JSON structure. The real content cap stays with the schemas; this limit
 * only keeps the HTTP transport from rejecting contract-valid requests
 * while remaining finite.
 */
export const AGENT_TEMPLATE_WRITE_BODY_LIMIT =
  MAX_AGENT_TEMPLATE_COMPONENTS * PROMPT_RESOURCE_BODY_MAX_CHARS * 6 + 2 * 1024 * 1024;

/**
 * MCP server names key provider projections case-insensitively, so they
 * must be unique case-insensitively within one Template — across transports
 * and independent of component keys.
 */
function assertUniqueTemplateMcpNames(components: ReadonlyArray<{ type: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, component] of components.entries()) {
    if (component.type !== "mcp" || !("payload" in component)) continue;
    const payload: unknown = component.payload;
    if (typeof payload !== "object" || payload === null || !("name" in payload)) continue;
    const name = payload.name;
    if (typeof name !== "string") continue;
    const identity = name.toLowerCase();
    if (seen.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components", index, "payload", "name"],
        message: "MCP server names must be unique case-insensitively within a Template.",
      });
    }
    seen.add(identity);
  }
}

/**
 * PostgreSQL text compatibility. PostgreSQL text/jsonb columns cannot
 * represent the actual U+0000 character, so any Template text carrying it
 * would fail at persistence time with a 500 after the schema accepted it.
 * The Template contract rejects it at the narrowest boundary instead:
 * every string value and every object key in the write source and the
 * canonical persisted payload. The literal six-character text remains
 * legal — only the real control character is rejected.
 */
const POSTGRES_TEXT_INCOMPATIBLE_MESSAGE = "Text contains U+0000, which cannot be persisted to PostgreSQL.";
const MAX_POSTGRES_TEXT_SCAN_NODES = 100_000;
const MAX_POSTGRES_TEXT_SCAN_DEPTH = 64;

/**
 * Locate the first actual U+0000 in any string value or object key and
 * return its path, or null when clean. Iterative with a seen-set so cyclic
 * structures cannot recurse forever and pathological nesting fails closed
 * instead of overflowing the stack — safeParse must never throw here.
 */
function findPostgresIncompatibleTextPath(value: unknown): Array<string | number> | null {
  const stack: Array<{ value: unknown; path: Array<string | number>; depth: number }> = [{ value, path: [], depth: 0 }];
  const seen = new Set<unknown>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    nodes++;
    if (nodes > MAX_POSTGRES_TEXT_SCAN_NODES || current.depth > MAX_POSTGRES_TEXT_SCAN_DEPTH) {
      return current.path.length > 0 ? current.path : ["payload"];
    }
    const { value: node, path } = current;
    if (typeof node === "string") {
      if (node.includes("\u0000")) return path;
      continue;
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const [index, item] of node.entries()) {
        stack.push({ value: item, path: [...path, index], depth: current.depth + 1 });
      }
      continue;
    }
    if (node !== null && typeof node === "object") {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (key.includes("\u0000")) return [...path, key];
        stack.push({ value: item, path: [...path, key], depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function assertPostgresTextCompatible(value: unknown, ctx: z.RefinementCtx): void {
  const badPath = findPostgresIncompatibleTextPath(value);
  if (badPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: badPath,
      message: POSTGRES_TEXT_INCOMPATIBLE_MESSAGE,
    });
  }
}

export const agentTemplatePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    public: agentTemplatePublicProfileSchema,
    components: z.array(agentTemplateComponentSchema).max(MAX_AGENT_TEMPLATE_COMPONENTS),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    for (const [index, component] of payload.components.entries()) {
      if (seen.has(component.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", index, "key"],
          message: "Component keys must be unique within a Template.",
        });
      }
      seen.add(component.key);
    }
    assertUniqueTemplateMcpNames(payload.components, ctx);
    assertPostgresTextCompatible(payload, ctx);
  });
export type AgentTemplatePayload = z.infer<typeof agentTemplatePayloadSchema>;

// ---------------------------------------------------------------------------
// Catalog governance contract (Task 2): publisher write sources, lifecycle
// requests, and the public-safe read model. The persistence contract above
// stays canonical; these schemas describe what callers may send and what the
// public surface may ever see.
// ---------------------------------------------------------------------------

/** Public URL identity. Lowercase kebab-case, unique, immutable once published. */
export const AGENT_TEMPLATE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const agentTemplateSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(AGENT_TEMPLATE_SLUG_REGEX, "Template slugs must be lowercase kebab-case.");
export type AgentTemplateSlug = z.infer<typeof agentTemplateSlugSchema>;

/** User-visible Template name, shared by the write and read contracts. */
export const agentTemplateNameSchema = z.string().min(1).max(200);
export type AgentTemplateName = z.infer<typeof agentTemplateNameSchema>;

/**
 * Skill write source: the publisher submits only the component key and the
 * bundle attachment. Every other field (display name, derived payload,
 * bundle descriptor) is compiled server-side from the real ZIP so the
 * persisted skill summary can never drift from its bytes.
 */
export const agentTemplateSkillComponentInputSchema = z
  .object({
    key: agentTemplateComponentKeySchema,
    type: z.literal("skill"),
    bundleAttachmentId: z.string().uuid(),
  })
  .strict();
export type AgentTemplateSkillComponentInput = z.infer<typeof agentTemplateSkillComponentInputSchema>;

/**
 * Write source for one component. Prompt and MCP inputs are already the
 * canonical persisted shapes; only Skill differs (server-compiled).
 */
export const agentTemplateComponentInputSchema = z.discriminatedUnion("type", [
  agentTemplatePromptComponentSchema,
  agentTemplateSkillComponentInputSchema,
  agentTemplateMcpComponentSchema,
]);
export type AgentTemplateComponentInput = z.infer<typeof agentTemplateComponentInputSchema>;

function assertUniqueComponentInputKeys(components: readonly AgentTemplateComponentInput[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const [index, component] of components.entries()) {
    if (seen.has(component.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components", index, "key"],
        message: "Component keys must be unique within a Template.",
      });
    }
    seen.add(component.key);
  }
}

/**
 * Canonical server timestamp token. The server serializes `createdAt` /
 * `updatedAt` with full PostgreSQL precision in exactly this shape, and
 * mutation requests carry the previous value back verbatim as the
 * optimistic-concurrency token (`expectedUpdatedAt`). Keeping one schema for
 * both directions prevents response/response contract drift.
 */
export const agentTemplateTimestampSchema = z.string().datetime({ offset: true });

/** The `expectedUpdatedAt` compare-and-set token on mutation requests. */
export const agentTemplateExpectedUpdatedAtSchema = agentTemplateTimestampSchema;

export const createAgentTemplateSchema = z
  .object({
    slug: agentTemplateSlugSchema,
    name: agentTemplateNameSchema,
    public: agentTemplatePublicProfileSchema,
    components: z.array(agentTemplateComponentInputSchema).max(MAX_AGENT_TEMPLATE_COMPONENTS),
  })
  .strict()
  .superRefine((input, ctx) => {
    assertUniqueComponentInputKeys(input.components, ctx);
    assertUniqueTemplateMcpNames(input.components, ctx);
    assertPostgresTextCompatible(input, ctx);
  });
export type CreateAgentTemplate = z.infer<typeof createAgentTemplateSchema>;

/**
 * In-place update of a draft or active Template. `slug` is accepted only
 * while the Template is still a draft — the service rejects slug changes
 * after first publish. Components, when present, replace the full set.
 */
export const updateAgentTemplateSchema = z
  .object({
    expectedUpdatedAt: agentTemplateExpectedUpdatedAtSchema,
    slug: agentTemplateSlugSchema.optional(),
    name: agentTemplateNameSchema.optional(),
    public: agentTemplatePublicProfileSchema.optional(),
    components: z.array(agentTemplateComponentInputSchema).max(MAX_AGENT_TEMPLATE_COMPONENTS).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.slug === undefined &&
      input.name === undefined &&
      input.public === undefined &&
      input.components === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of slug, name, public, or components must be provided.",
      });
    }
    if (input.components) {
      assertUniqueComponentInputKeys(input.components, ctx);
      assertUniqueTemplateMcpNames(input.components, ctx);
    }
    assertPostgresTextCompatible(input, ctx);
  });
export type UpdateAgentTemplate = z.infer<typeof updateAgentTemplateSchema>;

export const publishAgentTemplateSchema = z
  .object({
    expectedUpdatedAt: agentTemplateExpectedUpdatedAtSchema,
  })
  .strict();
export type PublishAgentTemplate = z.infer<typeof publishAgentTemplateSchema>;

export const retireAgentTemplateSchema = z
  .object({
    expectedUpdatedAt: agentTemplateExpectedUpdatedAtSchema,
    replacementTemplateId: z.string().uuid().optional(),
  })
  .strict();
export type RetireAgentTemplate = z.infer<typeof retireAgentTemplateSchema>;

/**
 * Full replace-set write for an Agent's adopted Templates against the
 * shared `agent_configs.version` optimistic lock. No add/remove/order API —
 * the caller always submits the complete target set.
 */
export const updateAgentTemplatesSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    templateIds: agentTemplateIdsSchema,
  })
  .strict();
export type UpdateAgentTemplates = z.infer<typeof updateAgentTemplatesSchema>;

/** Safe replacement pointer on a retired Template's public detail. */
export const agentTemplateReplacementSummarySchema = z
  .object({
    slug: agentTemplateSlugSchema,
    name: agentTemplateNameSchema,
  })
  .strict();
export type AgentTemplateReplacementSummary = z.infer<typeof agentTemplateReplacementSummarySchema>;

/**
 * Public-safe read model. Explicit projection only: never components, raw
 * instructions, attachment ids, Skill bodies, or MCP connection details.
 */
export const agentTemplatePublicTemplateSchema = z
  .object({
    id: z.string().uuid(),
    slug: agentTemplateSlugSchema,
    name: agentTemplateNameSchema,
    status: z.enum(["active", "retired"]),
    public: agentTemplatePublicProfileSchema,
    updatedAt: agentTemplateTimestampSchema,
    replacement: agentTemplateReplacementSummarySchema.nullable(),
  })
  .strict();
export type AgentTemplatePublicTemplate = z.infer<typeof agentTemplatePublicTemplateSchema>;

export const agentTemplatePublicListSchema = z
  .object({
    templates: z.array(agentTemplatePublicTemplateSchema),
  })
  .strict();
export type AgentTemplatePublicList = z.infer<typeof agentTemplatePublicListSchema>;

/** Full row for the publisher-internal surface (includes the payload). */
export const agentTemplateDetailSchema = z
  .object({
    id: z.string().uuid(),
    slug: agentTemplateSlugSchema,
    name: agentTemplateNameSchema,
    status: agentTemplateStatusSchema,
    payload: agentTemplatePayloadSchema,
    replacementTemplateId: z.string().uuid().nullable(),
    createdBy: z.string(),
    updatedBy: z.string(),
    createdAt: agentTemplateTimestampSchema,
    updatedAt: agentTemplateTimestampSchema,
  })
  .strict();
export type AgentTemplateDetail = z.infer<typeof agentTemplateDetailSchema>;

export const agentTemplateDetailListSchema = z
  .object({
    templates: z.array(agentTemplateDetailSchema),
  })
  .strict();
export type AgentTemplateDetailList = z.infer<typeof agentTemplateDetailListSchema>;

/**
 * Public-safe summary of one adopted Template in the Agent Detail control
 * plane. `missing` covers deleted, draft, or projection-invalid rows; no
 * payload, component, bundle, or connection detail ever appears here.
 */
export const agentTemplateAdoptionSummarySchema = z.discriminatedUnion("status", [
  z
    .object({
      id: z.string().uuid(),
      status: z.literal("active"),
      slug: agentTemplateSlugSchema,
      name: agentTemplateNameSchema,
      public: agentTemplatePublicProfileSchema,
      replacement: z.null(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      status: z.literal("retired"),
      slug: agentTemplateSlugSchema,
      name: agentTemplateNameSchema,
      public: agentTemplatePublicProfileSchema,
      replacement: agentTemplateReplacementSummarySchema.nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      status: z.literal("missing"),
      slug: z.null(),
      name: z.null(),
      public: z.null(),
      replacement: z.null(),
    })
    .strict(),
]);
export type AgentTemplateAdoptionSummary = z.infer<typeof agentTemplateAdoptionSummarySchema>;

export const agentResourcesOutputSchema = z
  .object({
    version: z.number().int().positive(),
    /** Adopted official Agent Template ids (0-3, canonical order). */
    templateIds: agentTemplateIdsSchema,
    /** Same-order public-safe summaries for `templateIds`. */
    adoptedTemplates: z.array(agentTemplateAdoptionSummarySchema),
    effective: effectiveAgentResourcesSchema,
    bindings: z.array(agentResourceBindingInputSchema),
    availableTeamResources: z.array(resourceRowSchema),
    /**
     * Read-only rollout gate for Team Skill slash commands: the agent's
     * currently bound, route-consistent connected client runs a version
     * that parses the server-owned `teamSkillInvocation` message marker
     * fail-closed (see `supportsTeamSkillInvocationClientVersion`).
     * Computed from `clients.sdk_version` — no new persisted state. The
     * Web composer offers Team Skill menu entries only when this is true;
     * old, unknown-version, offline, or unbound clients read as false.
     */
    teamSkillInvocationSupported: z.boolean(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.adoptedTemplates.length !== output.templateIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adoptedTemplates"],
        message: "adoptedTemplates must have exactly one summary per templateId.",
      });
      return;
    }
    for (const [index, summary] of output.adoptedTemplates.entries()) {
      if (summary.id !== output.templateIds[index]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adoptedTemplates", index, "id"],
          message: "adoptedTemplates must be in the same order as templateIds.",
        });
      }
    }
  });
export type AgentResourcesOutput = z.infer<typeof agentResourcesOutputSchema>;
