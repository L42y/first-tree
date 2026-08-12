import { z } from "zod";
import { runtimeProviderSchema } from "./runtime-provider.js";

/** Server -> daemon command used to run one host-local readiness verification. */
export const RUNTIME_READINESS_CHECK_TYPE = "runtime-readiness:check" as const;

/**
 * Read-model states shared by Client, Server, and Web.
 *
 * `available` remains install-only. Every stronger state comes from a bounded
 * real provider run or from a safe Server projection (expiry/offline).
 */
export const runtimeReadinessStateSchema = z.enum([
  "available",
  "checking",
  "ready",
  "needs_login",
  "failed",
  "expired",
  "computer_offline",
]);
export type RuntimeReadinessState = z.infer<typeof runtimeReadinessStateSchema>;

export const runtimeReadinessErrorCodeSchema = z.enum([
  "needs_login",
  "timeout",
  "provider_unavailable",
  "provider_error",
  "provider_busy",
  "unsafe_activity",
  "unsupported_provider",
  "cancelled",
]);
export type RuntimeReadinessErrorCode = z.infer<typeof runtimeReadinessErrorCodeSchema>;

/** A bounded, redacted error safe to persist in Client capability metadata. */
export const runtimeReadinessErrorSchema = z.object({
  code: runtimeReadinessErrorCodeSchema,
  message: z.string().max(500).optional(),
});
export type RuntimeReadinessError = z.infer<typeof runtimeReadinessErrorSchema>;

/**
 * Provider-neutral runtime configuration that materially changes the run.
 * Values are forwarded only to the official host-local provider runtime. The
 * cache identity hashes this object; it never includes credentials or prompts.
 */
export const runtimeReadinessConfigSchema = z.object({
  model: z.string().min(1).max(256).optional(),
  reasoningEffort: z.string().min(1).max(64).optional(),
  serviceTier: z.string().min(1).max(128).optional(),
  /**
   * Non-reversible digest supplied by a caller that owns additional provider
   * config. Raw config and credentials never cross this contract.
   */
  configIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type RuntimeReadinessConfig = z.infer<typeof runtimeReadinessConfigSchema>;

export const runtimeReadinessResultSchema = z.object({
  state: runtimeReadinessStateSchema,
  /** SHA-256 of provider, runtime artifact facts, and normalized config. */
  identity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  checkedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: runtimeReadinessErrorSchema.optional(),
});
export type RuntimeReadinessResult = z.infer<typeof runtimeReadinessResultSchema>;

export const runtimeReadinessCheckRequestSchema = z.object({
  provider: runtimeProviderSchema,
  config: runtimeReadinessConfigSchema.optional(),
  /** Explicit retry bypasses a still-fresh cached success. */
  force: z.boolean().optional(),
});
export type RuntimeReadinessCheckRequest = z.infer<typeof runtimeReadinessCheckRequestSchema>;

export const runtimeReadinessCheckCommandSchema = runtimeReadinessCheckRequestSchema.extend({
  type: z.literal(RUNTIME_READINESS_CHECK_TYPE),
  ref: z.string().min(1),
});
export type RuntimeReadinessCheckCommand = z.infer<typeof runtimeReadinessCheckCommandSchema>;

export const runtimeReadinessStartRequestSchema = runtimeReadinessCheckRequestSchema;
export type RuntimeReadinessStartRequest = z.infer<typeof runtimeReadinessStartRequestSchema>;

export const runtimeReadinessStartResponseSchema = z.object({
  ref: z.string().min(1),
  started: z.literal(true),
});
export type RuntimeReadinessStartResponse = z.infer<typeof runtimeReadinessStartResponseSchema>;
