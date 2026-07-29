import { z } from "zod";
import { PROMPT_APPEND_MAX_LENGTH } from "./agent-runtime-config.js";

export const AGENT_TEMPLATE_MAX_SELECTION = 8;
export const AGENT_TEMPLATE_MAX_RESOURCES = 64;

export const AGENT_TEMPLATE_STATUSES = {
  ACTIVE: "active",
  RETIRED: "retired",
} as const;

export const agentTemplateStatusSchema = z.enum(["active", "retired"]);
export type AgentTemplateStatus = z.infer<typeof agentTemplateStatusSchema>;

export const agentTemplateIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Template id must be a lowercase kebab-case slug.");

function uniqueStringArraySchema(max: number, label: string) {
  return z
    .array(z.string().min(1))
    .max(max)
    .superRefine((values, ctx) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `${label} must be unique.`,
          });
        }
        seen.add(value);
      }
    });
}

export const agentTemplateIdsSchema = uniqueStringArraySchema(AGENT_TEMPLATE_MAX_SELECTION, "Template ids").pipe(
  z.array(agentTemplateIdSchema),
);

export const agentTemplateResourceIdsSchema = uniqueStringArraySchema(
  AGENT_TEMPLATE_MAX_RESOURCES,
  "Template Resource ids",
);

export const agentTemplateOutcomesSchema = z.array(z.string().trim().min(1).max(240)).max(8);

export const createAgentTemplateSchema = z
  .object({
    id: agentTemplateIdSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1000),
    outcomes: agentTemplateOutcomesSchema.default([]),
    customInstructions: z.string().min(1).max(PROMPT_APPEND_MAX_LENGTH),
    resourceIds: agentTemplateResourceIdsSchema.default([]),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();
export type CreateAgentTemplate = z.infer<typeof createAgentTemplateSchema>;

export const updateAgentTemplateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(1000).optional(),
    outcomes: agentTemplateOutcomesSchema.optional(),
    customInstructions: z.string().min(1).max(PROMPT_APPEND_MAX_LENGTH).optional(),
    resourceIds: agentTemplateResourceIdsSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.summary !== undefined ||
      value.outcomes !== undefined ||
      value.customInstructions !== undefined ||
      value.resourceIds !== undefined ||
      value.sortOrder !== undefined,
    "At least one Template field must be updated.",
  );
export type UpdateAgentTemplate = z.infer<typeof updateAgentTemplateSchema>;

export const retireAgentTemplateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type RetireAgentTemplate = z.infer<typeof retireAgentTemplateSchema>;

export const updateAgentTemplatesSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    templateIds: agentTemplateIdsSchema,
  })
  .strict();
export type UpdateAgentTemplates = z.infer<typeof updateAgentTemplatesSchema>;

export const agentTemplateSkillSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .strict();
export type AgentTemplateSkillSummary = z.infer<typeof agentTemplateSkillSummarySchema>;

export const agentTemplateMcpSummarySchema = z
  .object({
    name: z.string(),
    transport: z.enum(["stdio", "http", "sse"]),
  })
  .strict();
export type AgentTemplateMcpSummary = z.infer<typeof agentTemplateMcpSummarySchema>;

export const agentTemplateCatalogItemSchema = z
  .object({
    id: agentTemplateIdSchema,
    title: z.string(),
    summary: z.string(),
    outcomes: z.array(z.string()),
    customInstructions: z.string(),
    status: agentTemplateStatusSchema,
    skills: z.array(agentTemplateSkillSummarySchema),
    mcp: z.array(agentTemplateMcpSummarySchema),
  })
  .strict();
export type AgentTemplateCatalogItem = z.infer<typeof agentTemplateCatalogItemSchema>;

export const agentTemplateCatalogOutputSchema = z
  .object({
    items: z.array(agentTemplateCatalogItemSchema),
  })
  .strict();
export type AgentTemplateCatalogOutput = z.infer<typeof agentTemplateCatalogOutputSchema>;

export const agentTemplateDefinitionSchema = z
  .object({
    id: agentTemplateIdSchema,
    organizationId: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    summary: z.string(),
    outcomes: z.array(z.string()),
    customInstructions: z.string(),
    resourceIds: z.array(z.string()),
    status: agentTemplateStatusSchema,
    sortOrder: z.number().int().min(0),
    createdBy: z.string(),
    updatedBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type AgentTemplateDefinition = z.infer<typeof agentTemplateDefinitionSchema>;

export const agentTemplatesForAgentOutputSchema = z
  .object({
    version: z.number().int().positive(),
    templateIds: agentTemplateIdsSchema,
    templates: z.array(agentTemplateCatalogItemSchema),
  })
  .strict();
export type AgentTemplatesForAgentOutput = z.infer<typeof agentTemplatesForAgentOutputSchema>;
