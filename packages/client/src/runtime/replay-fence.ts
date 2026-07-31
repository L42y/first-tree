import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FENCE_VERSION = 1;

/** One durable replay-fence record, bound to a concrete chat + inbox message. */
export type ReplayFenceEntry = {
  readonly chatId: string;
  readonly messageId: string;
  readonly provider: string;
  /** First observed non-read-only tool effect that made replay unsafe. */
  readonly toolName: string;
  readonly toolUseId: string;
  /** ISO 8601 time the fence was persisted. */
  readonly fencedAt: string;
};

type ReplayFenceData = {
  version: number;
  entries: Record<string, ReplayFenceEntry>;
};

/** Narrow surface handlers need; the full store also exposes load/isFenced. */
export type ReplayFenceWriter = {
  /** Persist a fence; throws ReplayFenceError when the durable write fails. */
  fence(entry: ReplayFenceEntry): void;
  /** Drop a fence after its delivery settled; throws ReplayFenceError on write failure. */
  clear(chatId: string, messageId: string): void;
};

export class ReplayFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFenceError";
  }
}

function keyOf(chatId: string, messageId: string): string {
  return `${chatId}${messageId}`;
}

/**
 * ReplayFenceStore — durable record of provider-entered deliveries that have
 * already produced a non-read-only tool effect. Unlike SessionRegistry, these
 * facts are safety-critical: every mutation is written synchronously
 * (write-then-fsync-then-rename) and failures THROW instead of being logged
 * and swallowed. A store that cannot be trusted must fail closed — callers
 * treat load/persist errors as "do not re-enter the provider", never as
 * "safe to replay".
 *
 * Lifecycle: a handler fences (chatId, messageId) as soon as it observes an
 * unsafe tool call start, and clears the fence only after the delivery's
 * terminal settlement is confirmed. A crash in between leaves the fence on
 * disk, and the next process's dispatch gate refuses to start/resume a
 * provider turn for that concrete message, keeping it as unacknowledged
 * recovery debt instead of replaying the effect.
 */
export class ReplayFenceStore {
  private readonly filePath: string;
  private entries = new Map<string, ReplayFenceEntry>();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load persisted fences. Missing file means an empty store. */
  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      // File does not exist yet — empty store, no fences.
      this.loaded = true;
      return;
    }

    let data: ReplayFenceData;
    try {
      data = JSON.parse(raw) as ReplayFenceData;
    } catch (error) {
      throw new ReplayFenceError(
        `replay fence store is corrupted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof data !== "object" || data === null || data.version !== FENCE_VERSION) {
      throw new ReplayFenceError(`replay fence store has unsupported version: ${String(data?.version)}`);
    }
    if (typeof data.entries !== "object" || data.entries === null || Array.isArray(data.entries)) {
      throw new ReplayFenceError("replay fence store has malformed entries");
    }

    const loaded = new Map<string, ReplayFenceEntry>();
    for (const [key, entry] of Object.entries(data.entries)) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.chatId !== "string" ||
        typeof entry.messageId !== "string" ||
        keyOf(entry.chatId, entry.messageId) !== key
      ) {
        throw new ReplayFenceError(`replay fence store has malformed entry: ${key}`);
      }
      loaded.set(key, entry);
    }
    this.entries = loaded;
    this.loaded = true;
  }

  isFenced(chatId: string, messageId: string): boolean {
    return this.entries.has(keyOf(chatId, messageId));
  }

  fence(entry: ReplayFenceEntry): void {
    const key = keyOf(entry.chatId, entry.messageId);
    if (this.entries.has(key)) return;
    this.entries.set(key, entry);
    try {
      this.persist();
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  clear(chatId: string, messageId: string): void {
    const key = keyOf(chatId, messageId);
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    try {
      this.persist();
    } catch (error) {
      this.entries.set(key, existing);
      throw error;
    }
  }

  /** Test/debug surface: current in-memory fence records. */
  snapshot(): readonly ReplayFenceEntry[] {
    return [...this.entries.values()];
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  private persist(): void {
    const data: ReplayFenceData = { version: FENCE_VERSION, entries: {} };
    for (const [key, entry] of this.entries) {
      data.entries[key] = entry;
    }
    const tmpPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      const fd = openSync(tmpPath, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      throw new ReplayFenceError(
        `failed to persist replay fence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
