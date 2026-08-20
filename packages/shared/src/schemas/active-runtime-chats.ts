import { z } from "zod";

export const activeRuntimeChatIdsResponseSchema = z.object({
  chatIds: z.array(z.string().min(1)),
  /**
   * Every server-side session row that is currently active for this agent,
   * independent of the managing human's workspace visibility/engagement.
   * Optional for rolling compatibility with servers that only return the
   * human-scoped runtime working set.
   */
  activeSessionChatIds: z.array(z.string().min(1)).optional(),
});
export type ActiveRuntimeChatIdsResponse = z.infer<typeof activeRuntimeChatIdsResponseSchema>;
