import { z } from "zod";
import { findAssembledBriefingFingerprint } from "../agent-briefing-guard.js";
import { mcpStdioServerSchema, runtimeSkillBundleSchema } from "./agent-runtime-config.js";
import { promptResourcePayloadSchema, skillResourcePayloadSchema } from "./resource.js";

/**
 * Official Agent Template domain contract (schema/persistence only).
 *
 * A Template is a global, official one-shot starting configuration. When a
 * user adopts a Template, its components are imported into the adopting
 * Team's Resources; after import the Team Resources are the execution
 * authority and V1 never syncs later Template changes into existing Teams.
 */

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

const agentTemplateMcpHttpServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.literal("http"),
    url: z.string().url().refine(hasNoTemplateMcpUrlData, TEMPLATE_MCP_URL_MESSAGE),
  })
  .strict();

const agentTemplateMcpSseServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.literal("sse"),
    url: z.string().url().refine(hasNoTemplateMcpUrlData, TEMPLATE_MCP_URL_MESSAGE),
  })
  .strict();

const agentTemplateMcpStdioServerSchema = mcpStdioServerSchema
  .extend({
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
  })
  .strict();
export type AgentTemplatePublicProfile = z.infer<typeof agentTemplatePublicProfileSchema>;

export const agentTemplatePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    public: agentTemplatePublicProfileSchema,
    components: z.array(agentTemplateComponentSchema).max(100),
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
    components: z.array(agentTemplateComponentInputSchema).max(100),
  })
  .strict()
  .superRefine((input, ctx) => assertUniqueComponentInputKeys(input.components, ctx));
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
    components: z.array(agentTemplateComponentInputSchema).max(100).optional(),
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
    if (input.components) assertUniqueComponentInputKeys(input.components, ctx);
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
