import type { RuntimeProvider, SessionState } from "@first-tree/shared";
import type { pino } from "../cloud/observability/logger.js";
import type { AgentHandler } from "./handler.js";

/**
 * Provider suspend/drain callbacks can disappear across host sleep or
 * transport loss. Bound an operator pause so later inbox work can recover.
 */
export const OPERATOR_SUSPEND_TIMEOUT_MS = 30_000;

export class HandlerSuspendTimeoutError extends Error {
  constructor(chatId: string) {
    super(`handler suspend timed out after ${OPERATOR_SUSPEND_TIMEOUT_MS}ms for chat ${chatId}`);
    this.name = "HandlerSuspendTimeoutError";
  }
}

export async function waitForHandlerSuspend(chatId: string, suspend: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(suspend),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HandlerSuspendTimeoutError(chatId)), OPERATOR_SUSPEND_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RouteLeaseToken = {
  readonly generation: number;
  readonly handler: AgentHandler;
};

export type RouteTransitionToken = RouteLeaseToken & {
  readonly phase: "start" | "resume";
};

export type OperatorSuspendRouteCapture = {
  readonly unestablishedStart: boolean;
  readonly inFlightTransition: RouteTransitionToken | null;
};

function freezeRouteLease(token: RouteLeaseToken): RouteLeaseToken {
  return Object.freeze({ generation: token.generation, handler: token.handler });
}

function freezeRouteTransition(token: RouteTransitionToken): RouteTransitionToken {
  return Object.freeze({ generation: token.generation, handler: token.handler, phase: token.phase });
}

export type QuarantinedSession = {
  handler: AgentHandler;
  generation: number;
  reason: "operator_suspend_timeout";
  routeTransitionInFlight: boolean;
};

/**
 * Host-owned session identity RouteTeardownAuthority keys private route
 * state against. Migrated generation/pointer/readiness live only in this
 * authority's WeakMap.
 */
export type RouteTeardownHostEntry = {
  chatId: string;
  handler: AgentHandler;
  status: SessionState;
  suspending: Promise<void> | null;
  handlerStoppedBySuspend: AgentHandler | null;
};

type RouteState = {
  generation: number;
  transition: RouteTransitionToken | null;
  injectReady: boolean;
};

function emptyRouteState(): RouteState {
  return { generation: 0, transition: null, injectReady: false };
}

export type RouteTeardownAuthorityDeps = {
  log: pino.Logger;
  isShuttingDown: () => boolean;
  /** Identity check against the host session map (`sessions.get(chatId) === entry`). */
  getSession: (chatId: string) => RouteTeardownHostEntry | undefined;
  isActiveSlotHeld: (entry: RouteTeardownHostEntry) => boolean;
  createHandler: () => AgentHandler;
  invalidateDeliveryAdmission: (chatId: string) => void;
  runtimeProvider: () => RuntimeProvider;
  emitResilienceEvent: (chatId: string, eventName: string, payload: Record<string, unknown>) => void;
};

/**
 * Unique owner of route-transition fencing, handler retire/shutdown coalescing,
 * pending teardown debt, route-producer quiescence, and operator-suspend
 * quarantine ledgers. SessionRuntime composes this; it must not keep parallel
 * copies of these maps.
 */
export class RouteTeardownAuthority {
  /**
   * Per-chat teardown debt: handlers detached from their SessionEntry without a
   * CONFIRMED stop. A ref'd terminate joins/strictly tears down every pending
   * handler of the chat before it may ack; confirmed stops drop out of the set.
   */
  private readonly pendingTeardowns = new Map<string, Set<AgentHandler>>();
  /**
   * Chat-level authority for provider generations whose operator suspend
   * callback exceeded its bound. The entry lives for this manager's lifetime:
   * ordinary routing may replace the exact handler, while Reset remains
   * restart-required because provider teardown was never confirmed.
   */
  private readonly quarantinedSessions = new Map<string, QuarantinedSession>();
  /**
   * In-flight route producers (start/resume/retry provider calls), per chat.
   * Tracked from `beginRouteTransition` until the route settles: a canceled
   * transition can still MATERIALIZE late, and only the producer's settle
   * funnels that materialization into `discardStaleRouteTransition` → teardown
   * debt. Terminate and manager shutdown join these before they may ack/return.
   */
  private readonly routeProducers = new Map<string, Set<Promise<void>>>();
  /** Handlers invalidated while start/resume was unresolved must never be reused. */
  private readonly retiredHandlers = new WeakSet<AgentHandler>();
  /**
   * Coalesces concurrent cleanup; a stale settlement may enqueue a later
   * cleanup pass. Each entry keeps both faces of the shutdown: `raw`
   * (rejects on failure) for `observeFailure` callers such as the Reset
   * terminate, and `observed` (swallow-and-warn, always resolves) for
   * fire-and-forget callers — so a strict caller joining an in-flight
   * shutdown that a lenient caller started still sees the failure.
   */
  private readonly handlerShutdowns = new WeakMap<AgentHandler, { raw: Promise<void>; observed: Promise<void> }>();
  /** Authority-private per-session route generation/pointer/readiness. Never escapes. */
  private readonly routeBySession = new WeakMap<RouteTeardownHostEntry, RouteState>();

  constructor(private readonly deps: RouteTeardownAuthorityDeps) {}

  /** Create private route state for a live session. Host never constructs these fields. */
  attachLiveSession(entry: RouteTeardownHostEntry): void {
    this.routeBySession.set(entry, emptyRouteState());
  }

  private route(entry: RouteTeardownHostEntry): RouteState {
    const state = this.routeBySession.get(entry);
    if (!state) {
      throw new Error(`route teardown state missing for chat ${entry.chatId}`);
    }
    return state;
  }

  private peekRoute(entry: RouteTeardownHostEntry): RouteState | undefined {
    return this.routeBySession.get(entry);
  }

  hasQuarantinedChat(chatId: string): boolean {
    return this.quarantinedSessions.has(chatId);
  }

  quarantinedChatIds(): string[] {
    return [...this.quarantinedSessions.keys()];
  }

  quarantinedHandler(chatId: string): AgentHandler | undefined {
    return this.quarantinedSessions.get(chatId)?.handler;
  }

  isHandlerInAnyQuarantine(handler: AgentHandler): boolean {
    for (const quarantined of this.quarantinedSessions.values()) {
      if (quarantined.handler === handler) return true;
    }
    return false;
  }

  hasPendingTeardown(chatId: string): boolean {
    const pending = this.pendingTeardowns.get(chatId);
    return Boolean(pending && pending.size > 0);
  }

  pendingTeardownHandlers(chatId: string): AgentHandler[] {
    const pending = this.pendingTeardowns.get(chatId);
    return pending ? [...pending] : [];
  }

  pendingTeardownChatIds(): string[] {
    return [...this.pendingTeardowns.keys()];
  }

  allPendingTeardownEntries(): Array<[string, AgentHandler[]]> {
    return [...this.pendingTeardowns.entries()].map(([chatId, handlers]) => [chatId, [...handlers]]);
  }

  /**
   * Live iteration over pending-teardown chats. Mutating the ledger during
   * consumption matches Map.entries() (new keys are visited; deleted
   * not-yet-visited keys are skipped). Each batch is a snapshot of that chat's
   * set so the host never holds the mutable container.
   */
  *pendingTeardownChatBatches(): IterableIterator<[string, AgentHandler[]]> {
    for (const [chatId, pending] of this.pendingTeardowns) {
      yield [chatId, [...pending]];
    }
  }

  /**
   * Live iteration over pending-teardown handler sets (manager-shutdown retry
   * pass). Same Map.values() liveness as the historical host loop.
   */
  *pendingTeardownBatches(): IterableIterator<AgentHandler[]> {
    for (const pending of this.pendingTeardowns.values()) {
      yield [...pending];
    }
  }

  hasRouteProducers(chatId: string): boolean {
    return (this.routeProducers.get(chatId)?.size ?? 0) > 0;
  }

  routeProducerChatIds(): string[] {
    return [...this.routeProducers.keys()];
  }

  allRouteProducerPromises(): Promise<void>[] {
    return [...this.routeProducers.values()].flatMap((producers) => [...producers]);
  }

  hasInFlightTransition(entry: RouteTeardownHostEntry): boolean {
    return this.peekRoute(entry)?.transition != null;
  }

  isRouteInjectReady(entry: RouteTeardownHostEntry): boolean {
    return this.peekRoute(entry)?.injectReady === true;
  }

  currentRouteLease(entry: RouteTeardownHostEntry): RouteLeaseToken {
    return freezeRouteLease({ generation: this.route(entry).generation, handler: entry.handler });
  }

  captureGeneration(entry: RouteTeardownHostEntry): number {
    return this.peekRoute(entry)?.generation ?? 0;
  }

  isGenerationCurrent(entry: RouteTeardownHostEntry, generation: number): boolean {
    return this.route(entry).generation === generation;
  }

  /**
   * Open live inject once the in-flight start/resume head has proven provider
   * membership. Returns false when there is no live transition or the entry is
   * not holding an active slot.
   */
  markRouteInjectReady(entry: RouteTeardownHostEntry): boolean {
    const state = this.peekRoute(entry);
    if (!state || state.transition === null) return false;
    if (entry.status !== "active" || !this.deps.isActiveSlotHeld(entry)) return false;
    state.injectReady = true;
    return true;
  }

  /**
   * Operator-suspend settlement window: capture the in-flight token, drop the
   * transition pointer and inject latch without bumping generation, so
   * already-issued DeliveryTokens can still post notice+ACK. Returns only the
   * immutable orchestration outcome.
   */
  beginOperatorSuspendTransition(entry: RouteTeardownHostEntry): OperatorSuspendRouteCapture {
    const state = this.route(entry);
    const captured = state.transition;
    const unestablishedStart = captured?.phase === "start";
    state.transition = null;
    state.injectReady = false;
    return Object.freeze({
      unestablishedStart,
      inFlightTransition: captured ? freezeRouteTransition(captured) : null,
    });
  }

  /** Bump adoption generation after operator-suspend settlement. */
  completeOperatorSuspendAdoptionFence(entry: RouteTeardownHostEntry): void {
    this.route(entry).generation++;
  }

  isHandlerRetired(handler: AgentHandler): boolean {
    return this.retiredHandlers.has(handler);
  }

  retireHandler(handler: AgentHandler): void {
    this.retiredHandlers.add(handler);
  }

  /**
   * Strictly retire the handler whose Context source is no longer current.
   * Teardown debt and retired-handler custody stay inside this authority; the
   * host only decides when a source transition requires the operation.
   */
  async retireHandlerForContextSourceChange(entry: RouteTeardownHostEntry): Promise<void> {
    const staleHandler = entry.handler;
    if (entry.handlerStoppedBySuspend !== staleHandler && !this.isCurrentHandlerQuarantined(entry)) {
      this.registerPendingTeardown(entry.chatId, staleHandler);
      await this.shutdownHandler(staleHandler, "session_resume_context_source_changed", { observeFailure: true });
      this.dropPendingTeardown(entry.chatId, staleHandler);
      entry.handlerStoppedBySuspend = staleHandler;
    }
    this.retiredHandlers.add(staleHandler);
  }

  quarantineMatches(chatId: string, lease: RouteLeaseToken): boolean {
    const quarantined = this.quarantinedSessions.get(chatId);
    return quarantined?.handler === lease.handler && quarantined.generation === lease.generation;
  }

  isCurrentHandlerQuarantined(entry: RouteTeardownHostEntry): boolean {
    return this.quarantinedSessions.get(entry.chatId)?.handler === entry.handler;
  }

  isProviderAdmissionRestartRequired(chatId: string): boolean {
    return this.quarantinedSessions.get(chatId)?.routeTransitionInFlight === true;
  }

  quarantineRestartRequiredError(chatId: string, operation: "Reset" | "provider admission"): Error {
    const quarantined = this.quarantinedSessions.get(chatId);
    const reason = quarantined?.reason ?? "operator_suspend_timeout";
    return new Error(
      `${operation} blocked: ${reason}; provider teardown was not confirmed for chat ${chatId}. Restart this agent daemon and retry.`,
    );
  }

  quarantineTimedOutSuspend(entry: RouteTeardownHostEntry, transition: RouteTransitionToken | null): void {
    const generation = transition?.generation ?? this.route(entry).generation;
    const handler = transition?.handler ?? entry.handler;
    const routeTransitionInFlight = transition !== null;
    const quarantine: QuarantinedSession = {
      handler,
      generation,
      reason: "operator_suspend_timeout",
      routeTransitionInFlight,
    };
    this.quarantinedSessions.set(entry.chatId, quarantine);
    this.retiredHandlers.add(handler);
    // The quarantine is now the sole authority for this lost generation.
    // Remove its unresolved producer from ordinary lifecycle joins; the
    // producer's own finally remains safe when the set is already absent.
    if (transition) this.routeProducers.delete(entry.chatId);

    const provider = this.deps.runtimeProvider();
    const details = {
      provider,
      chatId: entry.chatId,
      generation,
      routeTransitionInFlight,
      routeTransitionPhase: transition?.phase ?? null,
      reason: quarantine.reason,
    };
    this.deps.log.error(details, "operator suspend timed out; provider session quarantined");
    this.deps.emitResilienceEvent(entry.chatId, "resilience.session.operator_suspend_timeout", details);
  }

  handlerForRouteTransition(
    entry: RouteTeardownHostEntry,
    createReplacement: () => AgentHandler = this.deps.createHandler,
  ): AgentHandler {
    if (!this.retiredHandlers.has(entry.handler)) return entry.handler;
    const previous = entry.handler;
    const handler = createReplacement();
    entry.handler = handler;
    // The quarantined generation has no trustworthy teardown join. Keep it
    // exclusively in quarantinedSessions: ordinary pendingTeardowns would
    // make later routes and manager shutdown wait on the lost callback again.
    if (this.quarantinedSessions.get(entry.chatId)?.handler === previous) return handler;
    // The retired handler's shutdown was fire-and-forget — never confirmed.
    // Record the debt so a ref'd terminate strictly confirms the stop before
    // it may ack (the join resolves immediately when the stop already
    // confirmed, dropping the debt right away). Skip entirely when the stop
    // was already confirmed by the suspend boundary — a confirmed-stopped
    // handler is not debt.
    if (entry.handlerStoppedBySuspend !== previous) {
      this.detachHandlerWithPendingTeardown(entry.chatId, previous, "handler_replaced_after_retire");
    }
    return handler;
  }

  beginRouteTransition(
    entry: RouteTeardownHostEntry,
    handler: AgentHandler,
    phase: RouteTransitionToken["phase"],
  ): RouteTransitionToken {
    const state = this.route(entry);
    state.generation++;
    state.injectReady = false;
    const transition = freezeRouteTransition({ generation: state.generation, handler, phase });
    state.transition = transition;
    return transition;
  }

  isCurrentRouteTransition(entry: RouteTeardownHostEntry, transition: RouteTransitionToken): boolean {
    return this.route(entry).transition === transition && this.isRouteAdoptionValid(entry, transition);
  }

  /** Shared identity checks for delivery-route leases (generation/handler/entry). */
  isDeliveryRouteIdentityValid(entry: RouteTeardownHostEntry, transition: RouteLeaseToken): boolean {
    return (
      this.deps.getSession(entry.chatId) === entry &&
      this.route(entry).generation === transition.generation &&
      entry.handler === transition.handler &&
      !this.retiredHandlers.has(transition.handler)
    );
  }

  /**
   * Active mutation/adoption fence for SessionContext and route receipt adoption.
   * Requires a live active slot and fails closed on manager shutdown. Manual
   * operator suspend releases the slot immediately — ordinary mutations must
   * not reopen through the settlement-only `suspended && suspending` window.
   */
  isRouteAdoptionValid(entry: RouteTeardownHostEntry, transition: RouteLeaseToken): boolean {
    return (
      !this.deps.isShuttingDown() &&
      this.isDeliveryRouteIdentityValid(entry, transition) &&
      entry.status === "active" &&
      this.deps.isActiveSlotHeld(entry)
    );
  }

  /**
   * Lease for already-issued DeliveryToken notice+ACK during graceful drain.
   * Ignores `shuttingDown` and additionally accepts the operator-suspend window
   * (`suspended && suspending`) so provider-entered custody can still settle.
   * Must not be used for ordinary SessionContext mutations.
   */
  isDeliverySettlementLeaseValid(entry: RouteTeardownHostEntry, transition: RouteLeaseToken): boolean {
    const leaseHolder =
      (entry.status === "active" && this.deps.isActiveSlotHeld(entry)) ||
      (entry.status === "suspended" && entry.suspending !== null);
    return this.isDeliveryRouteIdentityValid(entry, transition) && leaseHolder;
  }

  completeRouteTransition(entry: RouteTeardownHostEntry, transition: RouteTransitionToken): boolean {
    const state = this.route(entry);
    if (state.transition !== transition || !this.isRouteAdoptionValid(entry, transition)) return false;
    state.transition = null;
    state.injectReady = false;
    return true;
  }

  shutdownHandler(
    handler: AgentHandler,
    reason: string,
    opts: { afterPrior?: boolean; observeFailure?: boolean; settleProviderEntered?: boolean } = {},
  ): Promise<void> {
    const prior = this.handlerShutdowns.get(handler);
    // Joining a prior shutdown must not hide its failure from a strict
    // caller: `observeFailure` joins `raw`, lenient callers join `observed`.
    if (prior && opts.afterPrior !== true) return opts.observeFailure ? prior.raw : prior.observed;
    const raw = (prior?.observed ?? Promise.resolve()).then(() =>
      handler.shutdown(reason, {
        ...(opts.settleProviderEntered === true ? { settleProviderEntered: true } : {}),
      }),
    );
    // `observed` keeps the legacy swallow-and-warn semantics for
    // fire-and-forget callers; an `observeFailure` caller gets `raw` so a
    // teardown failure can fail its operation (Reset terminate apply-ack).
    // `raw`'s rejection is always handled by `observed`.
    const observed = raw.catch((err) => {
      this.deps.log.warn({ reason, err }, "handler shutdown failed");
    });
    const record = { raw, observed };
    this.handlerShutdowns.set(handler, record);
    void observed.finally(() => {
      if (this.handlerShutdowns.get(handler) === record) this.handlerShutdowns.delete(handler);
    });
    return opts.observeFailure ? raw : observed;
  }

  /** Record a detached, unconfirmed-stop handler as teardown debt for the chat. */
  registerPendingTeardown(chatId: string, handler: AgentHandler): void {
    let set = this.pendingTeardowns.get(chatId);
    if (!set) {
      set = new Set();
      this.pendingTeardowns.set(chatId, set);
    }
    set.add(handler);
  }

  dropPendingTeardown(chatId: string, handler: AgentHandler): void {
    const set = this.pendingTeardowns.get(chatId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.pendingTeardowns.delete(chatId);
  }

  /**
   * Drop a handler from every chat's pending-teardown set (manager-shutdown
   * bounded retry path after a confirmed stop).
   */
  dropPendingTeardownEverywhere(handler: AgentHandler): void {
    for (const [id, set] of this.pendingTeardowns) {
      if (set.delete(handler) && set.size === 0) this.pendingTeardowns.delete(id);
    }
  }

  /**
   * Register an in-flight route producer (the provider start/resume call of
   * a route transition). Returns the settle callback; the tracked promise
   * never rejects, so joining it is always safe.
   */
  registerRouteProducer(chatId: string): () => void {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    let set = this.routeProducers.get(chatId);
    if (!set) {
      set = new Set();
      this.routeProducers.set(chatId, set);
    }
    set.add(promise);
    return () => {
      resolvePromise();
      const current = this.routeProducers.get(chatId);
      if (!current) return;
      current.delete(promise);
      if (current.size === 0) this.routeProducers.delete(chatId);
    };
  }

  /**
   * Join every in-flight route producer for the chat, draining to a stable
   * quiet point. A producer's settle can reveal late materialization debt
   * (via `discardStaleRouteTransition`), so callers must run the debt drain
   * AFTER this returns.
   */
  async quiesceRouteProducers(chatId: string): Promise<void> {
    for (;;) {
      const producers = this.routeProducers.get(chatId);
      if (!producers || producers.size === 0) return;
      await Promise.allSettled([...producers]);
    }
  }

  /**
   * Route admission fence: before a chat may create a new provider route,
   * its teardown authority must be clean — otherwise the chat could run
   * "old handler never confirmed stopped + new provider route started".
   * Settles every pending handler strictly (coalescing joins in-flight
   * shutdowns). Returns false when a stop fails: the debt stays registered
   * and the caller must keep the delivery's recovery/retry custody instead
   * of routing.
   */
  async settleTeardownDebtBeforeRoute(chatId: string): Promise<boolean> {
    if (this.isProviderAdmissionRestartRequired(chatId)) {
      this.deps.log.error(
        { chatId, provider: this.deps.runtimeProvider(), reason: "operator_suspend_timeout" },
        "provider admission blocked by unresolved quarantined route transition; daemon restart required",
      );
      return false;
    }
    // Quiesce in-flight route producers FIRST: a canceled start/resume can
    // still materialize late, and its discard registers teardown debt only
    // when the producer settles — debt drained before this point would be
    // incomplete, and a fresh route started over an unquiesced producer
    // could race the late materialization. (Guarded so the common no-
    // producer case adds no extra awaits to the route hot path.)
    if ((this.routeProducers.get(chatId)?.size ?? 0) > 0) {
      await this.quiesceRouteProducers(chatId);
    }
    for (;;) {
      const pending = this.pendingTeardowns.get(chatId);
      if (!pending || pending.size === 0) return true;
      let settled = true;
      for (const pendingHandler of [...pending]) {
        try {
          await this.shutdownHandler(pendingHandler, "route_admission_teardown", { observeFailure: true });
          this.dropPendingTeardown(chatId, pendingHandler);
        } catch (err) {
          this.deps.log.warn({ chatId, err }, "route admission teardown failed; keeping recovery custody");
          settled = false;
        }
      }
      if (!settled) return false;
    }
  }

  /**
   * Detach a handler whose stop is not yet confirmed. Keeps the calling
   * path's existing fire-and-forget shutdown semantics (lenient observed
   * face still logs failures), but records the debt so a later ref'd
   * terminate strictly confirms the stop. The raw face drives
   * deregistration — a failed shutdown keeps the debt, so the terminate
   * retry loop converges instead of acking over a live old run.
   */
  detachHandlerWithPendingTeardown(chatId: string, handler: AgentHandler, reason: string): void {
    this.registerPendingTeardown(chatId, handler);
    void this.shutdownHandler(handler, reason, { observeFailure: true }).then(
      () => this.dropPendingTeardown(chatId, handler),
      () => {
        // Failure keeps the debt — a later ref'd terminate strictly retries.
      },
    );
  }

  retireTransitionHandler(transition: RouteTransitionToken, reason: string): void {
    this.retiredHandlers.add(transition.handler);
    void this.shutdownHandler(transition.handler, reason);
  }

  invalidateRouteTransition(entry: RouteTeardownHostEntry, reason: string): RouteTransitionToken | null {
    this.deps.invalidateDeliveryAdmission(entry.chatId);
    const state = this.route(entry);
    const transition = state.transition;
    state.generation++;
    state.transition = null;
    state.injectReady = false;
    if (transition) this.retireTransitionHandler(transition, reason);
    return transition;
  }

  discardStaleRouteTransition(chatId: string, transition: RouteTransitionToken, reason: string): void {
    this.retiredHandlers.add(transition.handler);
    if (this.quarantineMatches(chatId, transition)) {
      this.deps.log.warn(
        {
          chatId,
          provider: this.deps.runtimeProvider(),
          generation: transition.generation,
          phase: transition.phase,
          reason,
        },
        "late quarantined route completion ignored",
      );
      return;
    }
    // A stale route completion MATERIALIZES the handler (the canceled
    // start/resume returned late), so it needs a NEW shutdown chained after
    // any prior (a pre-materialization shutdown was a no-op). That stop's
    // outcome enters the pending-teardown authority: on failure the
    // possibly-live stale handler stays joinable for a ref'd terminate /
    // reconcile retry / manager shutdown instead of becoming ownerless.
    this.registerPendingTeardown(chatId, transition.handler);
    void this.shutdownHandler(transition.handler, reason, { afterPrior: true, observeFailure: true }).then(
      () => this.dropPendingTeardown(chatId, transition.handler),
      () => {
        // Failure keeps the debt — a later terminate / reconcile retries it.
      },
    );
  }
}
