import { z } from "zod";
import { canonicalResourceRepoKeySchema } from "./context-activation.js";

export const CONTEXT_INTEGRATION_PROVIDERS = ["claude-code", "codex"] as const;
export const contextIntegrationProviderSchema = z.enum(CONTEXT_INTEGRATION_PROVIDERS);
export type ContextIntegrationProvider = z.infer<typeof contextIntegrationProviderSchema>;

export const contextEnablementIntentSchema = z.enum(["settings", "onboarding"]);
export type ContextEnablementIntent = z.infer<typeof contextEnablementIntentSchema>;

export const contextEnablementHandoffQuerySchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    intent: contextEnablementIntentSchema.default("settings"),
  })
  .strict();
export type ContextEnablementHandoffQuery = z.infer<typeof contextEnablementHandoffQuerySchema>;

export const contextEnablementHandoffSchema = z
  .object({
    protocolVersion: z.literal(1),
    organizationId: z.string().min(1),
    teamDisplayName: z.string().min(1),
    role: z.enum(["admin", "member"]),
    provider: contextIntegrationProviderSchema,
    intent: contextEnablementIntentSchema,
    command: z.string().min(1),
    workingDirectoryInstruction: z.string().min(1),
  })
  .strict();
export type ContextEnablementHandoff = z.infer<typeof contextEnablementHandoffSchema>;

const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const contextIntegrationPathProjectSchema = z
  .object({
    kind: z.literal("path"),
    root: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"), {
        message: "Project root must be an absolute POSIX, drive-letter, or UNC path.",
      }),
  })
  .strict();

export const contextIntegrationPathlessProjectSchema = z.object({ kind: z.literal("pathless") }).strict();

export const contextIntegrationProjectSchema = z.discriminatedUnion("kind", [
  contextIntegrationPathProjectSchema,
  contextIntegrationPathlessProjectSchema,
]);
export type ContextIntegrationProject = z.infer<typeof contextIntegrationProjectSchema>;

export const contextIntegrationBindingSchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    project: contextIntegrationProjectSchema,
    organizationId: z.string().min(1),
  })
  .strict();
export type ContextIntegrationBinding = z.infer<typeof contextIntegrationBindingSchema>;

export const contextIntegrationConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    bindings: z.array(contextIntegrationBindingSchema).default([]),
  })
  .strict();
export type ContextIntegrationConfig = z.infer<typeof contextIntegrationConfigSchema>;

/** Read only at the atomic local migration boundary. */
export const legacyContextIntegrationBindingSchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    checkoutRoot: z.string().min(1),
    repositoryKey: canonicalResourceRepoKeySchema,
    organizationId: z.string().min(1),
  })
  .strict();
export type LegacyContextIntegrationBinding = z.infer<typeof legacyContextIntegrationBindingSchema>;

/** Read only at the atomic local migration boundary. */
export const legacyContextIntegrationConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindings: z.array(legacyContextIntegrationBindingSchema).default([]),
  })
  .strict();
export type LegacyContextIntegrationConfig = z.infer<typeof legacyContextIntegrationConfigSchema>;

export const contextIntegrationInstallManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.enum(["prod", "staging", "dev"]),
    provider: contextIntegrationProviderSchema,
    firstTreeVersion: z.string().min(1),
    bundleVersion: z.string().min(1),
    bundleDigest: sha256DigestSchema,
    policyDigest: sha256DigestSchema,
    adapterDigest: sha256DigestSchema,
    marketplaceName: z.string().min(1),
    pluginName: z.string().min(1),
    installedAt: z.string().datetime(),
  })
  .strict();
export type ContextIntegrationInstallManifest = z.infer<typeof contextIntegrationInstallManifestSchema>;

export const contextIntegrationInstallJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: contextIntegrationProviderSchema,
    operation: z.enum(["install", "repair", "unchanged", "uninstall"]),
    previousBundleDigest: sha256DigestSchema.nullable(),
    targetBundleDigest: sha256DigestSchema.nullable(),
    startedAt: z.string().datetime(),
    phase: z.enum([
      "prepared",
      "provider_installing",
      "provider_installed",
      "rollback_failed",
      "provider_uninstalling",
      "uninstall_failed",
    ]),
  })
  .strict();
export type ContextIntegrationInstallJournal = z.infer<typeof contextIntegrationInstallJournalSchema>;

export const contextIntegrationReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    channel: z.enum(["prod", "staging", "dev"]),
    bundleDigest: sha256DigestSchema,
    policyDigest: sha256DigestSchema,
    providers: z.record(
      contextIntegrationProviderSchema,
      z
        .object({
          adapterDigest: sha256DigestSchema,
          minimumVersion: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ContextIntegrationReleaseManifest = z.infer<typeof contextIntegrationReleaseManifestSchema>;
