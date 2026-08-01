import type { InboxEntryWithMessage } from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import { Deduplicator } from "./deduplicator.js";
import type {
  DeliveryCompletionDisposition,
  SessionMessage,
  TerminalRejectionEvidence,
  TurnOutcome,
} from "./handler.js";

export type DeliveryWork = {
  chatId: string;
  entryId: number;
  messageId: string;
};

export type DeliveryDecision =
  | { kind: "deliver"; work: DeliveryWork }
  | { kind: "duplicate-in-flight" }
  | { kind: "recovering" };

export type DeliveryRouteOwnership = "owned" | "settled" | "lost";

export type WorkSnapshot = {
  entries: Array<{
    entryId: number;
    messageId: string;
    phase: DeliveryPhase;
  }>;
  recoveryDebt: RecoveryDebt;
  admissionPending: boolean;
};

type DeliveryPhase = "open" | "owned" | "terminal";
type RecoveryDebt = "none" | "required" | "running";

type TrackedDelivery = {
  entryId: number;
  messageId: string;
  dedupKey: string;
  phase: DeliveryPhase;
  processingStartedAt?: number;
  terminalOutcome?: {
    status: "success" | "error";
    errorKind?: "deterministic" | "transient" | "unknown";
    handledAt: number;
    evidence?: TerminalRejectionEvidence;
  };
  ackAttempt?: {
    throughEntryId: number;
    reason: string;
    startedAt: number;
  };
  /**
   * Set when the replay-fence gate withheld this delivery before any route
   * ownership or processing started. A later redelivery of such an entry
   * must be re-admitted (not swallowed as duplicate-in-flight) once the
   * fence is gone — the server row is the only durable copy.
   */
  replayFencedWithheld?: boolean;
};

type ChatInboxLedger = {
  entries: TrackedDelivery[];
  recoveryDebt: RecoveryDebt;
  recoveryActivationReady: boolean;
  // Server recovery can redeliver several frames after one accepted request;
  // keep classifying that burst as recovery while any redelivered work is unsettled.
  recoveryWindowOpen: boolean;
  admissionQueue: Promise<void> | null;
  ackQueue: Promise<unknown> | null;
};

type InboxDeliveryCoordinatorConfig = {
  ackEntry: (entryId: number) => Promise<void>;
  recoverChat?: (chatId: string) => Promise<void>;
  onWorkChanged: (chatId: string) => void;
  /**
   * Called after concrete ledger entries are durably committed through a
   * confirmed ACK — including the recovery/redelivery retry path, which is
   * the only settlement route left when the original completion could not
   * ACK. Consumers reconcile per-delivery safety facts (replay fences) here.
   */
  onDeliveriesCommitted?: (chatId: string, messageIds: readonly string[]) => void;
  log: pino.Logger;
};

export class InboxDeliveryCoordinator {
  private readonly config: InboxDeliveryCoordinatorConfig;
  private readonly deduplicator = new Deduplicator(1000);
  private readonly recentlySettled = new Deduplicator(1000);
  private readonly ledgers = new Map<string, ChatInboxLedger>();
  private readonly recoveringChats = new Map<string, Promise<void>>();

  constructor(config: InboxDeliveryCoordinatorConfig) {
    this.config = config;
  }

  receive(entry: InboxEntryWithMessage): DeliveryDecision {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;
    const ledger = this.ledger(chatId);

    if (ledger.recoveryDebt !== "none") {
      return { kind: "recovering" };
    }

    const activeByEntryId = ledger.entries.find((tracked) => tracked.entryId === entry.id);
    if (activeByEntryId) {
      if (activeByEntryId.replayFencedWithheld) {
        // Previously withheld by the replay-fence gate before any custody:
        // re-admit so the route gate can re-evaluate (exactly-once, since
        // the flag is consumed here).
        activeByEntryId.replayFencedWithheld = undefined;
        this.emitWorkChanged(chatId);
        return { kind: "deliver", work: { chatId, entryId: entry.id, messageId } };
      }
      this.config.log.debug(
        { chatId, messageId, entryId: entry.id, phase: activeByEntryId.phase },
        "redelivery observed for active ledger entry",
      );
      if (activeByEntryId.phase === "terminal") {
        void this.ackThrough(chatId, activeByEntryId.entryId, "redelivery_terminal_retry", {
          requireTerminalPrefix: true,
        });
      }
      return { kind: "duplicate-in-flight" };
    }

    const dedupKey = this.dedupKey(chatId, messageId);
    if (this.deduplicator.isDuplicate(dedupKey)) {
      const stillInFlight = ledger.entries.some((tracked) => tracked.messageId === messageId);
      this.config.log.debug({ chatId, messageId, entryId: entry.id, stillInFlight }, "duplicate message observed");
      if (stillInFlight) return { kind: "duplicate-in-flight" };
      this.config.log.debug(
        { chatId, messageId, entryId: entry.id },
        "duplicate key is not tied to an active entry; reprocessing redelivery",
      );
    }

    ledger.entries.push({ entryId: entry.id, messageId, dedupKey, phase: "open" });
    ledger.entries.sort((a, b) => a.entryId - b.entryId);
    this.emitWorkChanged(chatId);
    return { kind: "deliver", work: { chatId, entryId: entry.id, messageId } };
  }

  shouldRecoverBeforeDispatch(chatId: string, hasHealthyLiveHandler: boolean, hasLocalRecoveryRisk: boolean): boolean {
    const ledger = this.ledgers.get(chatId);
    if (ledger?.recoveryActivationReady) return false;
    if (ledger?.recoveryDebt === "required" || ledger?.recoveryDebt === "running") return true;
    return Boolean(this.config.recoverChat) && hasLocalRecoveryRisk && !hasHealthyLiveHandler;
  }

  takeRecoveryActivationReady(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    if (ledger.recoveryActivationReady) {
      ledger.recoveryActivationReady = false;
      ledger.recoveryWindowOpen = true;
      return true;
    }
    return ledger.recoveryWindowOpen && this.hasUnsettledWork(chatId);
  }

  async recoverIfNeeded(chatId: string, reason: string): Promise<void> {
    await this.requestRecovery(chatId, reason);
  }

  private async requestRecovery(chatId: string, reason: string): Promise<void> {
    const existing = this.recoveringChats.get(chatId);
    if (existing) {
      await existing;
      return;
    }

    const recoverChat = this.config.recoverChat;
    const ledger = this.ledger(chatId);
    if (!recoverChat) {
      ledger.recoveryDebt = "required";
      this.emitWorkChanged(chatId);
      this.config.log.error(
        { chatId, reason },
        "chat requires inbox recovery but no recoverChat callback is configured",
      );
      return;
    }

    ledger.recoveryDebt = "running";
    this.emitWorkChanged(chatId);

    let recovery: Promise<void>;
    recovery = recoverChat(chatId)
      .then(() => {
        this.clearEntriesForRecoverySuccess(chatId);
        const current = this.ledger(chatId);
        current.recoveryDebt = "none";
        current.recoveryActivationReady = true;
        current.recoveryWindowOpen = false;
        this.config.log.debug({ chatId, reason }, "chat inbox recovery accepted before dispatch");
      })
      .catch((err) => {
        const current = this.ledger(chatId);
        current.recoveryDebt = "required";
        this.config.log.warn({ chatId, reason, err }, "chat inbox recovery failed before dispatch");
      })
      .finally(() => {
        if (this.recoveringChats.get(chatId) === recovery) this.recoveringChats.delete(chatId);
        this.emitWorkChanged(chatId);
      });

    this.recoveringChats.set(chatId, recovery);
    await recovery;
  }

  async runAdmission<T>(work: DeliveryWork, op: () => Promise<T>): Promise<T> {
    const ledger = this.ledger(work.chatId);
    const prev = ledger.admissionQueue ?? Promise.resolve();
    const next = prev.then(op, op);
    const queueMarker = next.then(
      () => {},
      () => {},
    );
    ledger.admissionQueue = queueMarker;
    this.emitWorkChanged(work.chatId);
    const cleanup = () => {
      if (ledger.admissionQueue === queueMarker) {
        ledger.admissionQueue = null;
        this.cleanupLedger(work.chatId);
        this.emitWorkChanged(work.chatId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  /**
   * Mark ledger entries withheld by the replay-fence gate (no custody
   * taken). Their next redelivery is re-admitted instead of swallowed as
   * duplicate-in-flight — the only path that lets server redelivery drive a
   * withheld delivery once its fence clears.
   */
  markReplayFenceWithheld(chatId: string, messageIds: readonly string[]): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return;
    const ids = new Set(messageIds);
    for (const tracked of ledger.entries) {
      if (ids.has(tracked.messageId) && tracked.phase === "open" && tracked.processingStartedAt === undefined) {
        tracked.replayFencedWithheld = true;
      }
    }
  }

  markOwned(work: DeliveryWork): DeliveryRouteOwnership {
    const tracked = this.findEntry(work.chatId, work.entryId);
    if (!tracked) {
      return this.recentlySettled.has(this.settledKey(work)) ? "settled" : "lost";
    }
    if (tracked.phase === "open") {
      tracked.phase = "owned";
      this.emitWorkChanged(work.chatId);
    }
    return "owned";
  }

  hasEntry(work: DeliveryWork): boolean {
    return this.findEntry(work.chatId, work.entryId)?.messageId === work.messageId;
  }

  markProcessingStarted(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    const entryIds = this.messageEntryIds(chatId, messages);
    if (entryIds.size === 0) return;
    let changed = false;
    for (const tracked of ledger.entries) {
      if (!entryIds.has(tracked.entryId)) continue;
      if (tracked.phase === "open") {
        tracked.phase = "owned";
        changed = true;
      }
      if (tracked.phase === "owned" && tracked.processingStartedAt === undefined) {
        tracked.processingStartedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.emitWorkChanged(chatId);
  }

  async finishTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    outcome: TurnOutcome,
  ): Promise<DeliveryCompletionDisposition> {
    const throughEntryId = this.lastMessageEntryId(chatId, messages);
    if (throughEntryId === undefined) {
      this.config.log.warn({ chatId }, "turn completion ignored because no inboxEntryId was provided");
      return "retry";
    }
    this.markTerminal(chatId, messages, outcome);
    // The completion is only "settled" once the concrete entries have left
    // the ledger through a confirmed ACK. ACK rejection, recovery debt, and
    // non-terminal prefix gaps all retain server custody and must surface as
    // "retry" so callers (e.g. replay-fence cleanup) do not treat the
    // delivery as durably finished.
    const committed = await this.ackThrough(chatId, throughEntryId, "finish_turn", { requireTerminalPrefix: true });
    return committed ? "settled" : "retry";
  }

  async terminalRejected(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
    evidence: TerminalRejectionEvidence,
  ): Promise<void> {
    const throughEntryId = this.lastMessageEntryId(chatId, messages);
    if (throughEntryId === undefined) {
      this.config.log.warn({ chatId, reason }, "terminal rejection ignored because no inboxEntryId was provided");
      return;
    }
    this.markTerminal(
      chatId,
      messages,
      {
        status: "error",
        terminal: true,
        errorKind: "deterministic",
      },
      evidence,
    );
    await this.ackThrough(chatId, throughEntryId, "terminal_rejected", { requireTerminalPrefix: true });
  }

  retryTurn(chatId: string, messages: SessionMessage | readonly SessionMessage[], reason: string): void {
    const entryIds = this.messageEntryIds(chatId, messages);
    if (entryIds.size === 0) return;
    const ledger = this.ledgers.get(chatId);
    if (!ledger?.entries.some((entry) => entryIds.has(entry.entryId))) return;
    void this.markRecoveryDebt(chatId, reason);
  }

  /**
   * Retain custody without asking the current socket to redeliver. Runtime
   * proof failures cannot make progress on that socket: both the failed turn
   * and its durable HTTP notice use the same stale proof. A successful
   * `agent:bound` is the only boundary that may release this hold.
   */
  async holdTurnForBindRecovery(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
  ): Promise<boolean> {
    const entryIds = this.messageEntryIds(chatId, messages);
    if (entryIds.size === 0) return false;
    const ledger = this.ledgers.get(chatId);
    if (!ledger?.entries.some((entry) => entryIds.has(entry.entryId))) return false;
    await this.markRecoveryDebt(chatId, reason, { requestNow: false });
    return true;
  }

  /**
   * The server resets delivered rows before it emits `agent:bound`, then
   * drains them after the frame. Clear only the proof-fault ledger here so
   * the subsequent redelivery can establish fresh local ownership.
   */
  completeBindRecovery(chatId: string): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return;
    this.clearEntriesForRecoverySuccess(chatId);
    const current = this.ledger(chatId);
    current.recoveryDebt = "none";
    current.recoveryActivationReady = true;
    current.recoveryWindowOpen = false;
    this.config.log.info({ chatId }, "bind recovery released held inbox work");
    this.emitWorkChanged(chatId);
  }

  async prepareSuspend(chatId: string, reason: string): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;

    let terminalPrefixCount = 0;
    for (const tracked of ledger.entries) {
      if (tracked.phase !== "terminal") break;
      terminalPrefixCount++;
    }

    if (terminalPrefixCount > 0) {
      const lastTerminal = ledger.entries[terminalPrefixCount - 1];
      if (lastTerminal) {
        await this.ackThrough(chatId, lastTerminal.entryId, `${reason}:terminal_prefix`, {
          requireTerminalPrefix: true,
        });
      }
    }

    const remaining = this.ledgers.get(chatId)?.entries ?? [];
    if (remaining.length > 0) await this.markRecoveryDebt(chatId, reason);
  }

  async prepareOperatorSuspend(chatId: string): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;

    let resolvablePrefixCount = 0;
    let changed = false;
    const handledAt = Date.now();
    for (const tracked of ledger.entries) {
      if (tracked.phase === "terminal") {
        resolvablePrefixCount++;
        continue;
      }
      if (tracked.phase === "owned" && tracked.processingStartedAt !== undefined) {
        tracked.phase = "terminal";
        tracked.terminalOutcome = {
          status: "error",
          errorKind: "deterministic",
          handledAt,
        };
        resolvablePrefixCount++;
        changed = true;
        continue;
      }
      break;
    }
    if (changed) this.emitWorkChanged(chatId);

    if (resolvablePrefixCount > 0) {
      const lastResolvable = ledger.entries[resolvablePrefixCount - 1];
      if (lastResolvable) {
        await this.ackThrough(chatId, lastResolvable.entryId, "operator_suspended:resolved_prefix", {
          requireTerminalPrefix: true,
          requestRecoveryOnAckFailure: false,
        });
      }
    }

    const remaining = this.ledgers.get(chatId)?.entries ?? [];
    if (remaining.length > 0) {
      await this.markRecoveryDebt(chatId, "operator_suspended:deferred_tail", { requestNow: false });
    }
  }

  prepareEvict(chatId: string, reason: string): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    void this.markRecoveryDebt(chatId, reason);
  }

  async drainForTerminate(chatId: string): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;

    let terminalPrefixCount = 0;
    for (const tracked of ledger.entries) {
      if (tracked.phase !== "terminal") break;
      terminalPrefixCount++;
    }
    if (terminalPrefixCount > 0) {
      const lastTerminal = ledger.entries[terminalPrefixCount - 1];
      if (lastTerminal) {
        await this.ackThrough(chatId, lastTerminal.entryId, "terminate", { requireTerminalPrefix: true });
      }
    }

    const remaining = this.ledgers.get(chatId)?.entries ?? [];
    if (remaining.length > 0) await this.markRecoveryDebt(chatId, "terminate_non_terminal_remainder");
  }

  hasUnsettledWork(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    return ledger.entries.length > 0 || ledger.recoveryDebt !== "none" || ledger.admissionQueue !== null;
  }

  hasProcessingOwnedWork(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    return ledger.entries.some((entry) => entry.phase === "owned" && entry.processingStartedAt !== undefined);
  }

  hasRecoveryDebt(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    return ledger?.recoveryDebt !== undefined && ledger.recoveryDebt !== "none";
  }

  snapshot(chatId: string): WorkSnapshot {
    const ledger = this.ledgers.get(chatId);
    return {
      entries: (ledger?.entries ?? []).map((entry) => ({
        entryId: entry.entryId,
        messageId: entry.messageId,
        phase: entry.phase,
      })),
      recoveryDebt: ledger?.recoveryDebt ?? "none",
      admissionPending: ledger?.admissionQueue !== null,
    };
  }

  private async ackThrough(
    chatId: string,
    throughEntryId: number,
    reason: string,
    opts: { requireTerminalPrefix?: boolean; requestRecoveryOnAckFailure?: boolean } = {},
  ): Promise<boolean> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    const prev: Promise<unknown> = ledger.ackQueue ?? Promise.resolve(false);
    const next = prev.catch(() => false).then(() => this.ackThroughNow(chatId, throughEntryId, reason, opts));
    const queueMarker = next.then(
      () => {},
      () => {},
    );
    ledger.ackQueue = queueMarker;
    this.emitWorkChanged(chatId);
    try {
      return await next;
    } finally {
      if (ledger.ackQueue === queueMarker) {
        ledger.ackQueue = null;
        this.cleanupLedger(chatId);
        this.emitWorkChanged(chatId);
      }
    }
  }

  private async ackThroughNow(
    chatId: string,
    throughEntryId: number,
    reason: string,
    opts: { requireTerminalPrefix?: boolean; requestRecoveryOnAckFailure?: boolean },
  ): Promise<boolean> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return false;
    if (ledger.recoveryDebt !== "none") {
      this.config.log.debug(
        { chatId, throughEntryId, reason },
        "ACK-through deferred because chat recovery is required",
      );
      return false;
    }
    const index = ledger.entries.findIndex((tracked) => tracked.entryId === throughEntryId);
    if (index < 0) {
      this.config.log.warn({ chatId, throughEntryId, reason }, "attempt completion ignored for untracked inbox entry");
      return false;
    }

    const ackPrefix = ledger.entries.slice(0, index + 1);
    if (opts.requireTerminalPrefix && ackPrefix.some((tracked) => tracked.phase !== "terminal")) {
      this.config.log.warn(
        {
          chatId,
          throughEntryId,
          reason,
          prefix: ackPrefix.map((entry) => ({ entryId: entry.entryId, phase: entry.phase })),
        },
        "ACK-through blocked because delivery prefix has non-terminal entries",
      );
      await this.markRecoveryDebt(chatId, `${reason}:non_terminal_prefix_gap`);
      return false;
    }
    let changed = false;
    for (const tracked of ackPrefix) {
      if (!tracked.ackAttempt || tracked.ackAttempt.throughEntryId !== throughEntryId) {
        tracked.ackAttempt = { throughEntryId, reason, startedAt: Date.now() };
        changed = true;
      }
    }
    if (changed) this.emitWorkChanged(chatId);

    try {
      await this.config.ackEntry(throughEntryId);
    } catch (err) {
      this.config.log.warn({ chatId, entryId: throughEntryId, reason, err }, "ACK-through failed; retaining ledger");
      const current = this.ledgers.get(chatId);
      if (current) {
        for (const tracked of current.entries) {
          if (tracked.entryId <= throughEntryId) {
            tracked.ackAttempt = undefined;
          }
        }
      }
      this.emitWorkChanged(chatId);
      void this.markRecoveryDebt(chatId, `${reason}:ack_failed`, {
        requestNow: opts.requestRecoveryOnAckFailure ?? true,
      });
      return false;
    }

    const current = this.ledgers.get(chatId);
    if (!current) return false;
    const committed = current.entries.filter((tracked) => tracked.entryId <= throughEntryId);
    current.entries = current.entries.filter((tracked) => tracked.entryId > throughEntryId);
    for (const tracked of committed) {
      this.deduplicator.drop(tracked.dedupKey);
      this.recentlySettled.isDuplicate(
        this.settledKey({ chatId, entryId: tracked.entryId, messageId: tracked.messageId }),
      );
    }
    if (committed.length > 0) {
      this.config.onDeliveriesCommitted?.(
        chatId,
        committed.map((tracked) => tracked.messageId),
      );
    }
    if (current.entries.length === 0 && current.recoveryDebt === "required") {
      current.recoveryDebt = "none";
    }
    this.cleanupLedger(chatId);
    this.emitWorkChanged(chatId);
    return true;
  }

  private async markRecoveryDebt(chatId: string, reason: string, opts: { requestNow?: boolean } = {}): Promise<void> {
    const ledger = this.ledger(chatId);
    if (ledger.recoveryDebt !== "required") {
      ledger.recoveryDebt = "required";
      this.emitWorkChanged(chatId);
    }
    this.config.log.warn(
      { chatId, reason, entryIds: ledger.entries.map((entry) => entry.entryId) },
      "chat has unsettled inbox work; waiting for recovery redelivery",
    );
    if (opts.requestNow === false) return;
    await this.requestRecovery(chatId, reason);
  }

  private clearEntriesForRecoverySuccess(chatId: string): void {
    const ledger = this.ledger(chatId);
    const nonTerminal = ledger.entries.filter((tracked) => tracked.phase !== "terminal");
    for (const tracked of nonTerminal) {
      this.deduplicator.drop(tracked.dedupKey);
    }
    ledger.entries = ledger.entries.filter((tracked) => tracked.phase === "terminal");
  }

  private findEntry(chatId: string, entryId: number): TrackedDelivery | null {
    return this.ledgers.get(chatId)?.entries.find((entry) => entry.entryId === entryId) ?? null;
  }

  private messageEntryIds(chatId: string, messages: SessionMessage | readonly SessionMessage[]): Set<number> {
    const batch = Array.isArray(messages) ? messages : [messages];
    const entryIds = new Set<number>();
    for (const message of batch) {
      if (message.chatId === chatId && message.inboxEntryId !== undefined) entryIds.add(message.inboxEntryId);
    }
    return entryIds;
  }

  private lastMessageEntryId(chatId: string, messages: SessionMessage | readonly SessionMessage[]): number | undefined {
    const batch = Array.isArray(messages) ? messages : [messages];
    let throughEntryId: number | undefined;
    for (const message of batch) {
      if (message.chatId !== chatId) continue;
      if (message.inboxEntryId !== undefined) throughEntryId = message.inboxEntryId;
    }
    return throughEntryId;
  }

  private markTerminal(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    outcome: TurnOutcome,
    evidence?: TerminalRejectionEvidence,
  ): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    const terminalIds = this.messageEntryIds(chatId, messages);
    if (terminalIds.size === 0) return;
    let changed = false;
    for (const tracked of ledger.entries) {
      if (!terminalIds.has(tracked.entryId)) continue;
      if (tracked.phase !== "terminal") {
        tracked.phase = "terminal";
        changed = true;
      }
      if (!tracked.terminalOutcome) {
        tracked.terminalOutcome = {
          status: outcome.status,
          errorKind: outcome.errorKind,
          handledAt: Date.now(),
          evidence,
        };
        changed = true;
      }
    }
    if (changed) this.emitWorkChanged(chatId);
  }

  private ledger(chatId: string): ChatInboxLedger {
    const existing = this.ledgers.get(chatId);
    if (existing) return existing;
    const ledger: ChatInboxLedger = {
      entries: [],
      recoveryDebt: "none",
      recoveryActivationReady: false,
      recoveryWindowOpen: false,
      admissionQueue: null,
      ackQueue: null,
    };
    this.ledgers.set(chatId, ledger);
    return ledger;
  }

  private cleanupLedger(chatId: string): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return;
    if (
      ledger.recoveryWindowOpen &&
      ledger.entries.length === 0 &&
      ledger.recoveryDebt === "none" &&
      ledger.admissionQueue === null &&
      ledger.ackQueue === null
    ) {
      ledger.recoveryWindowOpen = false;
    }
    if (
      ledger.entries.length === 0 &&
      ledger.recoveryDebt === "none" &&
      !ledger.recoveryActivationReady &&
      !ledger.recoveryWindowOpen &&
      ledger.admissionQueue === null &&
      ledger.ackQueue === null
    ) {
      this.ledgers.delete(chatId);
    }
  }

  private emitWorkChanged(chatId: string): void {
    this.config.onWorkChanged(chatId);
  }

  private dedupKey(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  private settledKey(work: DeliveryWork): string {
    return `${work.chatId}:${work.entryId}:${work.messageId}`;
  }
}
