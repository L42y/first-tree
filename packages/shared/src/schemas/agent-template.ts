import { z } from "zod";
import { runtimeSkillBundleSchema } from "./agent-runtime-config.js";
import { noSecretMcpServerSchema, promptResourcePayloadSchema, skillResourcePayloadSchema } from "./resource.js";

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
    payload: promptResourcePayloadSchema.strict(),
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

/** MCP component: imports as a Team MCP Resource. Secrets are not allowed. */
export const agentTemplateMcpComponentSchema = z
  .object({
    ...agentTemplateComponentBaseShape,
    type: z.literal("mcp"),
    payload: noSecretMcpServerSchema,
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
