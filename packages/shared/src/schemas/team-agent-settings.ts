import { z } from "zod";
import { agentVisibilitySchema } from "./agent.js";
import { setupBlockerSchema, setupCapabilityHealthSchema } from "./setup-capabilities.js";

export const teamAgentAssignmentInputSchema = z
  .object({
    agentUuid: z.string().min(1).nullable(),
  })
  .strict();

export const teamAgentCandidateRuntimeSchema = z
  .object({
    health: setupCapabilityHealthSchema,
    blockers: z.array(setupBlockerSchema),
  })
  .strict();

export const teamAgentCandidateSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string().nullable(),
    displayName: z.string().min(1),
    visibility: agentVisibilitySchema,
    runtime: teamAgentCandidateRuntimeSchema,
  })
  .strict();

export const teamAgentCandidatesOutputSchema = z
  .object({
    items: z.array(teamAgentCandidateSchema),
    blockers: z.array(setupBlockerSchema),
  })
  .strict();

export type TeamAgentAssignmentInput = z.infer<typeof teamAgentAssignmentInputSchema>;
export type TeamAgentCandidateRuntime = z.infer<typeof teamAgentCandidateRuntimeSchema>;
export type TeamAgentCandidate = z.infer<typeof teamAgentCandidateSchema>;
export type TeamAgentCandidatesOutput = z.infer<typeof teamAgentCandidatesOutputSchema>;
