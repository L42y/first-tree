import { z } from "zod";

export const sessionEventKind = z.enum([
  "tool_call",
  "error",
  "assistant_text",
  "thinking",
  "turn_end",
  "context_tree_usage",
  "token_usage",
]);
export type SessionEventKind = z.infer<typeof sessionEventKind>;

export const toolFileRefPathKindSchema = z.enum(["file", "directory", "repo"]);
export type ToolFileRefPathKind = z.infer<typeof toolFileRefPathKindSchema>;

export const toolFileRefOriginSchema = z.enum(["tool_arg", "file_change", "runtime_metadata", "git_status_delta"]);
export type ToolFileRefOrigin = z.infer<typeof toolFileRefOriginSchema>;

export const toolFileRefSchema = z.object({
  localPath: z.string().min(1).optional(),
  repoUrl: z.string().min(1).optional(),
  repoBranch: z.string().min(1).optional(),
  // The checkout HEAD observed for the successful read. This identifies the
  // candidate Git snapshot without claiming that a dirty local file
  // necessarily matched that commit.
  repoHeadCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  repoRelativePath: z.string().min(1).optional(),
  pathKind: toolFileRefPathKindSchema.optional(),
  origin: toolFileRefOriginSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ToolFileRef = z.infer<typeof toolFileRefSchema>;

export const toolCallEventPayload = z.object({
  toolUseId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["pending", "ok", "error"]),
  durationMs: z.number().int().nonnegative().optional(),
  resultPreview: z.string().max(400).optional(),
  toolFileRefs: z.array(toolFileRefSchema).optional(),
});
export type ToolCallEventPayload = z.infer<typeof toolCallEventPayload>;

export const errorEventPayload = z.object({
  source: z.enum(["sdk", "runtime", "tool"]),
  message: z.string().max(2000),
});
export type ErrorEventPayload = z.infer<typeof errorEventPayload>;

/**
 * A text block emitted by the model within an assistant message. A long block
 * is split across consecutive events that each fit the cap below (see
 * `client/handlers/assistant-text.ts#chunkAssistantText`), so the persisted
 * stream is a complete, lossless record of what the agent said. The per-turn
 * final-text chat mirror is RETIRED — the agent's output is NOT delivered as a
 * chat message; these events are the durable troubleshooting record. A
 * human-visible reply is a deliberate `chat send <human>` / `chat ask` the
 * agent issues itself, not an automatic forward. The live chat timeline still
 * renders these only for the in-progress turn (it folds completed turns), but
 * the events remain persisted and queryable after `turn_end`.
 */
export const assistantTextEventPayload = z.object({
  text: z.string().max(8000),
});
export type AssistantTextEventPayload = z.infer<typeof assistantTextEventPayload>;

/**
 * Marker emitted when the model produces a `thinking` content block.
 * We intentionally do NOT persist the thinking content — only a presence
 * signal so the UI can render a lightweight "Thinking…" status indicator.
 */
export const thinkingEventPayload = z.object({});
export type ThinkingEventPayload = z.infer<typeof thinkingEventPayload>;

/**
 * Turn boundary marker. Emitted once per completed query turn, regardless of
 * success/failure, so the frontend can group events into turns and fold a
 * completed turn's transient events (assistant_text / thinking / tool_call)
 * out of the live timeline. The folded events stay persisted (queryable for
 * troubleshooting); the durable human-visible result, if any, is whatever
 * deliberate `chat send` / `chat ask` the agent issued — not an auto-forward.
 */
export const turnEndEventPayload = z.object({
  status: z.enum(["success", "error"]),
  turnCompletionId: z.string().min(1).optional(),
});
export type TurnEndEventPayload = z.infer<typeof turnEndEventPayload>;

export const contextTreeUsageEventPayload = z.object({
  purpose: z.literal("design_decision"),
  treeRepoUrl: z.string().nullable(),
  // Tree-root-relative path of the file the agent actually Read (e.g.
  // `members/Gandy2025/NODE.md`). Null when the read target could not be
  // resolved to a node path. Emitted only when a view tool reads a file under
  // the configured Context Tree root — see the client handler's tool-call
  // processor.
  //
  nodePath: z.string().nullable(),
});
export type ContextTreeUsageEventPayload = z.infer<typeof contextTreeUsageEventPayload>;

/**
 * Token usage for one (provider, model) within a single turn. Emitted by the
 * handler right before `turn_end`. A turn may produce multiple `token_usage`
 * events when the underlying SDK runs more than one model in a single turn
 * (e.g. Claude Agent SDK fast-mode). Codex emits at most one.
 *
 * Field semantics — `inputTokens` and `cachedInputTokens` are DISJOINT, so
 * total prompt tokens = inputTokens + cachedInputTokens:
 *   - `inputTokens`: prompt tokens NOT served from cache. For Anthropic this
 *     includes cache-creation tokens (they bill as input). For OpenAI/Codex
 *     `usage.input_tokens` is the TOTAL prompt incl. the cached subset, so the
 *     codex handler subtracts (`input_tokens - cached_input_tokens`) to land
 *     on the non-cached figure this field expects.
 *   - `cachedInputTokens`: prompt tokens served from cache (Anthropic
 *     `cache_read_input_tokens` / OpenAI `cached_input_tokens`).
 *   - `outputTokens`: completion tokens (includes reasoning tokens for o-series
 *     models — we deliberately do not split them out in this minimal schema).
 *
 * All values are PER-TURN deltas. Codex's SDK only surfaces the cumulative
 * thread total, so its handler diffs consecutive turns to recover the delta
 * (see `computePerTurnUsageDelta`); summing these events over a thread is
 * therefore valid for both providers.
 */
export const tokenUsageEventPayload = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsageEventPayload = z.infer<typeof tokenUsageEventPayload>;

/**
 * Chat-wide token usage total — the server's SUM over every `token_usage`
 * event persisted for a chat. Because `token_usage` events are per-turn deltas
 * (see {@link tokenUsageEventPayload}), summing them yields the cumulative
 * consumption of the whole chat. Note the count resets when a session is
 * terminated (its events are cleared), so this is "usage since the current
 * session history began", not an all-time billing figure.
 */
export const chatTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type ChatTokenUsage = z.infer<typeof chatTokenUsageSchema>;

export const sessionEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_call"), payload: toolCallEventPayload }),
  z.object({ kind: z.literal("error"), payload: errorEventPayload }),
  z.object({ kind: z.literal("assistant_text"), payload: assistantTextEventPayload }),
  z.object({ kind: z.literal("thinking"), payload: thinkingEventPayload }),
  z.object({ kind: z.literal("turn_end"), payload: turnEndEventPayload }),
  z.object({ kind: z.literal("context_tree_usage"), payload: contextTreeUsageEventPayload }),
  z.object({ kind: z.literal("token_usage"), payload: tokenUsageEventPayload }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** Persisted session-event row (as returned by admin API / services). */
export const sessionEventRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  chatId: z.string(),
  seq: z.number().int().positive(),
  kind: sessionEventKind,
  payload: z.union([
    toolCallEventPayload,
    errorEventPayload,
    assistantTextEventPayload,
    thinkingEventPayload,
    turnEndEventPayload,
    contextTreeUsageEventPayload,
    tokenUsageEventPayload,
  ]),
  createdAt: z.string(),
});
export type SessionEventRow = z.infer<typeof sessionEventRowSchema>;

/** WS message: client reports a session event (tool_call / error) to the server. */
export const sessionEventMessageSchema = z.object({
  agentId: z.string(),
  chatId: z.string(),
  event: sessionEventSchema,
  ref: z.string().min(1).optional(),
});
export type SessionEventMessage = z.infer<typeof sessionEventMessageSchema>;

export const sessionEventRejectedReasonSchema = z.enum(["agent_not_bound", "malformed", "persist_failed"]);
export type SessionEventRejectedReason = z.infer<typeof sessionEventRejectedReasonSchema>;

/**
 * Client→Server apply-acknowledgement for a ref'd `session:terminate`
 * command. Sent ONLY after the client's `SessionRuntime.handleCommand(...,
 * "session:terminate")` has fully resolved — local handler stopped, provider
 * session mapping dropped — so the server can treat `applied: true` as proof
 * the old provider session is gone before it evicts and clears traces.
 * `applied: false` (or no ack at all) means the reset must fail and stay
 * retryable.
 */
export const sessionCommandAppliedFrameSchema = z.object({
  type: z.literal("session:command:applied"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  command: z.literal("session:terminate"),
  applied: z.boolean(),
});
export type SessionCommandAppliedFrame = z.infer<typeof sessionCommandAppliedFrameSchema>;

/**
 * Server→Client confirmation that a ref'd Reset terminate has finished
 * `finalizeTerminatedSession` (session row is `evicted`). The client must not
 * release parked Reset-fence inbox recovery until this frame arrives — otherwise
 * `inbox:recover` can race the HTTP finalize path.
 *
 * `ref` is the terminate ref, so the client can scope the release to the Reset
 * generation it actually armed. `ackRef` is a SEPARATE rendezvous id the client
 * echoes in {@link sessionCommandFinalizedAckFrameSchema}: the apply-ack wake
 * for `ref` may still be in flight across replicas when the finalize waiter is
 * registered, and a same-ref waiter would consume that stale wake.
 */
export const sessionCommandFinalizedFrameSchema = z.object({
  type: z.literal("session:command:finalized"),
  ref: z.string().min(1),
  ackRef: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  command: z.literal("session:terminate"),
  state: z.literal("evicted"),
});
export type SessionCommandFinalizedFrame = z.infer<typeof sessionCommandFinalizedFrameSchema>;

/**
 * Client→Server receipt for {@link sessionCommandFinalizedFrameSchema}, sent
 * after the client released (or knowingly declined to release) parked
 * Reset-fence recovery for that exact generation. The Reset HTTP request stays
 * open until this receipt lands on the exact client route, so a lost
 * post-finalize signal fails the request closed instead of leaving the client
 * parked forever behind a fence nobody will lift.
 */
export const sessionCommandFinalizedAckFrameSchema = z.object({
  type: z.literal("session:command:finalized:ack"),
  ref: z.string().min(1),
  ackRef: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  command: z.literal("session:terminate"),
  /** False when the ref did not match a locally armed Reset generation. */
  released: z.boolean(),
});
export type SessionCommandFinalizedAckFrame = z.infer<typeof sessionCommandFinalizedAckFrameSchema>;

/**
 * Why a Reset generation is being lifted WITHOUT a durable eviction:
 *
 *   - `reactivated`    — `finalizeTerminatedSession` did not commit `evicted`
 *                        (a new addressed message re-activated the session
 *                        while the apply-ack was in flight);
 *   - `route_refused`  — the last-in-transaction route revalidation refused
 *                        the eviction after the client had already applied;
 *   - `cleanup_failed` — the atomic evict + trace-clear transaction threw, so
 *                        nothing was committed.
 */
export const sessionCommandAbortReasonSchema = z.enum(["reactivated", "route_refused", "cleanup_failed"]);
export type SessionCommandAbortReason = z.infer<typeof sessionCommandAbortReasonSchema>;

/**
 * Server→Client terminal disposition for a ref'd Reset terminate the client
 * TRUTHFULLY applied but the server could not finalize. It mirrors
 * {@link sessionCommandFinalizedFrameSchema} because the client's obligation is
 * identical: once `session:command:applied` with `applied: true` is accepted,
 * the client's Reset generation is armed and only an exact, receipted
 * disposition for that `ref` can lift it. Without this frame a server branch
 * that throws (reactivation, route refusal, cleanup failure) would return an
 * HTTP error and leave the chat fenced forever.
 *
 * Aborting does NOT restore the retired provider mapping or the old session —
 * that mapping is durably gone the moment the client acked. It only lifts that
 * exact generation, so the durable unACKed row recovers once on the same
 * socket into a fresh nonce-derived provider session.
 *
 * The frame is addressed to the ORIGINAL applying client identity, not the
 * agent's current route: abort exists precisely for the case where the route
 * moved or the session re-activated after a truthful apply.
 */
export const sessionCommandAbortedFrameSchema = z.object({
  type: z.literal("session:command:aborted"),
  ref: z.string().min(1),
  ackRef: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  command: z.literal("session:terminate"),
  reason: sessionCommandAbortReasonSchema,
});
export type SessionCommandAbortedFrame = z.infer<typeof sessionCommandAbortedFrameSchema>;

/**
 * Client→Server receipt for {@link sessionCommandAbortedFrameSchema}, the exact
 * counterpart of {@link sessionCommandFinalizedAckFrameSchema}. The Reset HTTP
 * request stays open until this lands, so a lost abort signal fails the request
 * closed instead of silently leaving the client parked. `released: false` is
 * the honest answer for a stale, foreign, or superseded ref — such a ref must
 * never lift a newer generation.
 */
export const sessionCommandAbortedAckFrameSchema = z.object({
  type: z.literal("session:command:aborted:ack"),
  ref: z.string().min(1),
  ackRef: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  command: z.literal("session:terminate"),
  /** False when the ref did not match a locally armed Reset generation. */
  released: z.boolean(),
});
export type SessionCommandAbortedAckFrame = z.infer<typeof sessionCommandAbortedAckFrameSchema>;

export const sessionEventAcceptedFrameSchema = z.object({
  type: z.literal("session:event:accepted"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
});
export type SessionEventAcceptedFrame = z.infer<typeof sessionEventAcceptedFrameSchema>;

export const sessionEventRejectedFrameSchema = z.object({
  type: z.literal("session:event:rejected"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1).optional(),
  reason: sessionEventRejectedReasonSchema,
});
export type SessionEventRejectedFrame = z.infer<typeof sessionEventRejectedFrameSchema>;
