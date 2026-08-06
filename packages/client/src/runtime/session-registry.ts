import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../observability/logger.js";

const REGISTRY_VERSION = 1;

type PersistedEntry = {
  claudeSessionId: string;
  lastActivity: string; // ISO 8601
  status: "active" | "suspended" | "evicted";
};

type RegistryData = {
  version: number;
  entries: Record<string, PersistedEntry>;
  /**
   * Optional per-chat opaque Reset nonces. Absent on legacy v1 files — those
   * load with an empty nonce map while preserving every existing mapping.
   * Tombstones outlive mapping deletion: a durable inbox row can still arrive
   * after Reset, and the nonce keeps reconstructible fresh-start identities
   * from reopening the discarded provider artifact.
   */
  freshStartNonces?: Record<string, string>;
  /**
   * Optional per-chat removal/resume generations. Absent on legacy files ⇒ 0
   * for every chat (pre-migration mappings are generation 0).
   */
  resumeGenerations?: Record<string, number>;
};

export type RegistryEntry = { claudeSessionId: string; lastActivity: number; status: string };

export type RegistrySnapshot = {
  entries: Map<string, RegistryEntry>;
  freshStartNonces: Map<string, string>;
  resumeGenerations: Map<string, number>;
};

/**
 * SessionRegistry — persists `chatId → claudeSessionId` mappings to disk,
 * plus optional per-chat Reset fresh-start nonces and resume generations.
 *
 * Write strategy: debounced write-then-rename for atomicity. Every write
 * carries the current authoritative mapping set AND the full nonce /
 * generation maps so a stale debounced snapshot cannot erase a tombstone or
 * resurrect a deleted mapping.
 *
 * On load, all entries start as `suspended`.
 */
export class SessionRegistry {
  private readonly filePath: string;
  private readonly logger = createLogger("session-registry");
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntries: Map<string, RegistryEntry> | null = null;
  /** Authoritative in-memory Reset nonces; always written with every flush. */
  private freshStartNonces = new Map<string, string>();
  /** Authoritative per-chat resume/removal generations; default absent ⇒ 0. */
  private resumeGenerations = new Map<string, number>();
  /**
   * Nonces rotated for an in-flight Reset whose durable flush has not yet
   * succeeded. Retained across flushOrThrow failures so a genuine retry
   * reuses the same nonce instead of rotating unpredictably.
   */
  private pendingResetRotations = new Map<string, string>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load mappings from disk. Preserves the historical public return shape
   * (`Map<chatId, entry>`). Also hydrates the authoritative in-memory Reset
   * nonce map as a side effect so subsequent get/rotate/flush see durable
   * tombstones; callers that need the nonce map should use `loadSnapshot()`.
   */
  load(): Map<string, RegistryEntry> {
    return this.loadSnapshot().entries;
  }

  /**
   * Load the full registry snapshot (mappings + Reset fresh-start nonces +
   * resume generations). Both this and `load()` populate the in-memory maps
   * from disk.
   */
  loadSnapshot(): RegistrySnapshot {
    const entries = new Map<string, RegistryEntry>();
    const freshStartNonces = new Map<string, string>();
    const resumeGenerations = new Map<string, number>();

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as RegistryData;

      if (data.version !== REGISTRY_VERSION) {
        // Version mismatch — discard and start fresh
        this.freshStartNonces = freshStartNonces;
        this.resumeGenerations = resumeGenerations;
        this.pendingResetRotations.clear();
        return { entries, freshStartNonces, resumeGenerations };
      }

      for (const [chatId, entry] of Object.entries(data.entries ?? {})) {
        entries.set(chatId, {
          claudeSessionId: entry.claudeSessionId,
          lastActivity: new Date(entry.lastActivity).getTime(),
          status: entry.status,
        });
      }
      if (data.freshStartNonces && typeof data.freshStartNonces === "object") {
        for (const [chatId, nonce] of Object.entries(data.freshStartNonces)) {
          if (typeof nonce === "string" && nonce.length > 0) {
            freshStartNonces.set(chatId, nonce);
          }
        }
      }
      if (data.resumeGenerations && typeof data.resumeGenerations === "object") {
        for (const [chatId, generation] of Object.entries(data.resumeGenerations)) {
          if (typeof generation === "number" && Number.isInteger(generation) && generation >= 0) {
            resumeGenerations.set(chatId, generation);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }

    this.freshStartNonces = new Map(freshStartNonces);
    this.resumeGenerations = new Map(resumeGenerations);
    this.pendingResetRotations.clear();
    return { entries, freshStartNonces, resumeGenerations };
  }

  getFreshStartNonce(chatId: string): string | undefined {
    return this.freshStartNonces.get(chatId);
  }

  getResumeGeneration(chatId: string): number {
    return this.resumeGenerations.get(chatId) ?? 0;
  }

  /** Persist the adopted resume generation for a chat (monotonic; never decreases). */
  setResumeGeneration(chatId: string, generation: number): void {
    const current = this.resumeGenerations.get(chatId) ?? 0;
    if (generation < current) return;
    this.resumeGenerations.set(chatId, generation);
  }

  /**
   * Roll back an in-memory resume generation after a failed durable flush.
   * Only used when adoption failed before the generation became admissible.
   */
  revertResumeGeneration(chatId: string, generation: number): void {
    if (generation <= 0) {
      this.resumeGenerations.delete(chatId);
      return;
    }
    this.resumeGenerations.set(chatId, generation);
  }

  /**
   * Rotate the chat's fresh-start nonce for a Reset attempt. The first call
   * for an in-flight Reset mints a cryptographically random UUID; a failed
   * flush keeps that pending rotation so the genuine retry writes the same
   * nonce with the mapping deletion.
   */
  rotateFreshStartNonce(chatId: string): string {
    const pending = this.pendingResetRotations.get(chatId);
    if (pending) return pending;
    const nonce = randomUUID();
    this.pendingResetRotations.set(chatId, nonce);
    this.freshStartNonces.set(chatId, nonce);
    return nonce;
  }

  /** Clear the in-flight rotation marker after a successful Reset flush. */
  markResetNonceDurable(chatId: string): void {
    this.pendingResetRotations.delete(chatId);
  }

  /** Mark the registry as dirty; a debounced write will follow. */
  save(entries: Map<string, RegistryEntry>): void {
    this.pendingEntries = entries;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        if (this.pendingEntries) {
          this.flush(this.pendingEntries);
          this.pendingEntries = null;
        }
      }, 1000);
    }
  }

  /** Force an immediate write (used during shutdown). */
  flush(entries: Map<string, RegistryEntry>): void {
    this.clearPendingWrite();
    try {
      this.writeToDisk(entries);
    } catch (err) {
      // Log but don't throw — registry persistence is best-effort
      this.logger.warn(`Failed to persist: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Force an immediate write and propagate failure to the caller. Used by
   * chat-session Reset: the client apply-acks `session:terminate` only after
   * the mapping deletion (and Reset tombstone) are durable, so a failed write
   * must fail the terminate instead of being swallowed.
   */
  flushOrThrow(entries: Map<string, RegistryEntry>): void {
    this.clearPendingWrite();
    this.writeToDisk(entries);
  }

  private clearPendingWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    // flush(entries) is authoritative — `entries` is the freshest known
    // mapping state. Any older debounced snapshot in pendingEntries is now
    // stale, so drop it; otherwise dispose()'s pending fallback would later
    // rewrite the stale snapshot on top of what we just persisted. Nonces
    // always come from the authoritative in-memory map at write time.
    this.pendingEntries = null;
  }

  private writeToDisk(entries: Map<string, RegistryEntry>): void {
    const freshStartNonces: Record<string, string> = {};
    for (const [chatId, nonce] of this.freshStartNonces) {
      freshStartNonces[chatId] = nonce;
    }
    const resumeGenerations: Record<string, number> = {};
    for (const [chatId, generation] of this.resumeGenerations) {
      if (generation > 0) resumeGenerations[chatId] = generation;
    }
    const data: RegistryData = {
      version: REGISTRY_VERSION,
      entries: {},
      freshStartNonces,
      resumeGenerations,
    };

    for (const [chatId, entry] of entries) {
      data.entries[chatId] = {
        claudeSessionId: entry.claudeSessionId,
        lastActivity: new Date(entry.lastActivity).toISOString(),
        status: entry.status as PersistedEntry["status"],
      };
    }

    const tmpPath = `${this.filePath}.tmp`;

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  /** Flush any pending debounced write, then clean up timers. */
  dispose(): void {
    if (this.pendingEntries) {
      // flush() clears writeTimer internally — persist the last debounced
      // mapping instead of dropping it when torn down inside the 1s window.
      this.flush(this.pendingEntries);
      this.pendingEntries = null;
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}
