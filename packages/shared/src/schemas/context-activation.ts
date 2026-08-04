import { z } from "zod";
import { contextTreeActiveBindingSchema } from "./org-settings.js";
import { canonicalizeResourceRepoUrl } from "./resource.js";

export const CONTEXT_ACTIVATION_SCHEMA_VERSION = 2 as const;

/**
 * Canonical repository keys are the credential-free output of
 * `canonicalizeResourceRepoUrl()`, not raw Git remotes.
 */
export const canonicalResourceRepoKeySchema = z
  .string()
  .min(3)
  .max(2048)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return character === "@" || /\s/u.test(character) || codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }),
    {
      message: "Repository key must not contain credentials, whitespace, or control characters.",
    },
  )
  .refine(
    (value) => {
      try {
        return canonicalizeResourceRepoUrl(`https://${value}`) === value;
      } catch {
        return false;
      }
    },
    { message: "Repository key must use the canonical Team resource identity." },
  );
export type CanonicalResourceRepoKey = z.infer<typeof canonicalResourceRepoKeySchema>;

export const legacyContextActivationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryKey: canonicalResourceRepoKeySchema,
  })
  .strict();
export type LegacyContextActivationRequest = z.infer<typeof legacyContextActivationRequestSchema>;

export const contextActivationV2RequestSchema = z.object({ schemaVersion: z.literal(2) }).strict();
export type ContextActivationV2Request = z.infer<typeof contextActivationV2RequestSchema>;

export const contextActivationRequestSchema = z.union([
  legacyContextActivationRequestSchema,
  contextActivationV2RequestSchema,
]);
export type ContextActivationRequest = z.infer<typeof contextActivationRequestSchema>;

const contextActivationTeamSchema = z
  .object({
    organizationId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

const contextActivationAuthorizedTeamSchema = contextActivationTeamSchema.extend({
  role: z.enum(["admin", "member"]),
});

const contextActivationNextActionSchema = z
  .object({
    message: z.string().min(1),
    settingsUrl: z.string().min(1).optional(),
  })
  .strict();

export const legacyContextActivationResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(1),
      outcome: z.literal("disabled"),
      team: contextActivationTeamSchema,
      reasonCode: z.literal("repository_not_in_selected_team_scope"),
      nextAction: contextActivationNextActionSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      outcome: z.literal("connected"),
      team: contextActivationAuthorizedTeamSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      outcome: z.literal("needs_admin"),
      team: contextActivationAuthorizedTeamSchema,
      reasonCode: z.enum(["context_tree_unbound", "context_tree_binding_invalid", "context_tree_provider_unresolved"]),
      nextAction: contextActivationNextActionSchema.extend({
        settingsUrl: z.string().min(1),
      }),
    })
    .strict(),
]);
export type LegacyContextActivationResponse = z.infer<typeof legacyContextActivationResponseSchema>;

export const contextActivationV2ResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(2),
      outcome: z.literal("connected"),
      team: contextActivationAuthorizedTeamSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      outcome: z.literal("needs_admin"),
      team: contextActivationAuthorizedTeamSchema,
      reasonCode: z.enum(["context_tree_unbound", "context_tree_binding_invalid", "context_tree_provider_unresolved"]),
      nextAction: contextActivationNextActionSchema.extend({
        settingsUrl: z.string().min(1),
      }),
    })
    .strict(),
]);
export type ContextActivationV2Response = z.infer<typeof contextActivationV2ResponseSchema>;

export const contextActivationResponseSchema = z.union([
  legacyContextActivationResponseSchema,
  contextActivationV2ResponseSchema,
]);
export type ContextActivationResponse = z.infer<typeof contextActivationResponseSchema>;

export const contextRouteCandidatesRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationIds: z.array(z.string().min(1)).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.organizationIds).size !== value.organizationIds.length) {
      context.addIssue({ code: "custom", message: "organizationIds must be unique", path: ["organizationIds"] });
    }
  });
export type ContextRouteCandidatesRequest = z.infer<typeof contextRouteCandidatesRequestSchema>;

export const contextRouteCandidatesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidates: z.array(
      z.discriminatedUnion("outcome", [
        z
          .object({
            organizationId: z.string().min(1),
            outcome: z.literal("connected"),
            team: contextActivationAuthorizedTeamSchema,
            binding: contextTreeActiveBindingSchema,
          })
          .strict(),
        z
          .object({
            organizationId: z.string().min(1),
            outcome: z.literal("unavailable"),
            reasonCode: z.enum([
              "not_member",
              "context_tree_unbound",
              "context_tree_binding_invalid",
              "context_tree_provider_unresolved",
            ]),
            message: z.string().min(1),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type ContextRouteCandidatesResponse = z.infer<typeof contextRouteCandidatesResponseSchema>;
