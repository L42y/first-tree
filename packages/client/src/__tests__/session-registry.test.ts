import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig } from "../cloud/observability/logger.js";
import { SessionRegistry } from "../runtime/session-registry.js";

function collectLogs(): { dest: Writable; read: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { dest, read: () => chunks.join("") };
}

describe("SessionRegistry", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `session-registry-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, "sessions.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeEntries(data: Record<string, { claudeSessionId: string; lastActivity: number; status: string }>) {
    return new Map(Object.entries(data));
  }

  it("round-trips save and load via the public Map contract", () => {
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
      "chat-2": { claudeSessionId: "sess-bbb", lastActivity: 1700001000000, status: "suspended" },
    });

    registry.flush(entries);
    registry.dispose();

    const registry2 = new SessionRegistry(filePath);
    const loaded = registry2.load();
    registry2.dispose();

    expect(loaded).toBeInstanceOf(Map);
    expect(loaded.size).toBe(2);
    expect(loaded.get("chat-1")?.claudeSessionId).toBe("sess-aaa");
    expect(loaded.get("chat-1")?.lastActivity).toBe(1700000000000);
    expect(loaded.get("chat-1")?.status).toBe("active");
    expect(loaded.get("chat-2")?.claudeSessionId).toBe("sess-bbb");
    expect(loaded.get("chat-2")?.status).toBe("suspended");
  });

  it("loadSnapshot returns mappings plus fresh-start nonces", () => {
    const registry = new SessionRegistry(filePath);
    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
      }),
    );
    const nonce = registry.rotateFreshStartNonce("chat-1");
    registry.flushOrThrow(new Map());
    registry.markResetNonceDurable("chat-1");
    registry.dispose();

    const snapshot = new SessionRegistry(filePath).loadSnapshot();
    expect(snapshot.entries.size).toBe(0);
    expect(snapshot.freshStartNonces.get("chat-1")).toBe(nonce);
  });

  it("load and loadSnapshot both hydrate the in-memory nonce map", () => {
    const writer = new SessionRegistry(filePath);
    writer.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
      }),
    );
    const nonce = writer.rotateFreshStartNonce("chat-1");
    writer.flushOrThrow(new Map());
    writer.markResetNonceDurable("chat-1");
    writer.dispose();

    const viaLoad = new SessionRegistry(filePath);
    viaLoad.load();
    expect(viaLoad.getFreshStartNonce("chat-1")).toBe(nonce);

    const viaSnapshot = new SessionRegistry(filePath);
    viaSnapshot.loadSnapshot();
    expect(viaSnapshot.getFreshStartNonce("chat-1")).toBe(nonce);
  });

  it("returns empty map when file does not exist", () => {
    const registry = new SessionRegistry(join(testDir, "nonexistent.json"));
    const loaded = registry.load();
    const snapshot = registry.loadSnapshot();
    registry.dispose();

    expect(loaded.size).toBe(0);
    expect(snapshot.entries.size).toBe(0);
    expect(snapshot.freshStartNonces.size).toBe(0);
  });

  it("returns empty maps on version mismatch", () => {
    writeFileSync(filePath, JSON.stringify({ version: 999, entries: { "chat-1": {} } }), "utf-8");

    const registry = new SessionRegistry(filePath);
    expect(registry.load().size).toBe(0);
    const snapshot = registry.loadSnapshot();
    registry.dispose();

    expect(snapshot.entries.size).toBe(0);
    expect(snapshot.freshStartNonces.size).toBe(0);
  });

  it("returns empty maps on corrupted JSON", () => {
    writeFileSync(filePath, "not valid json {{{{", "utf-8");

    const registry = new SessionRegistry(filePath);
    expect(registry.load().size).toBe(0);
    const snapshot = registry.loadSnapshot();
    registry.dispose();

    expect(snapshot.entries.size).toBe(0);
    expect(snapshot.freshStartNonces.size).toBe(0);
  });

  it("loads legacy v1 files without freshStartNonces while preserving mappings", () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "chat-legacy": {
            claudeSessionId: "sess-legacy",
            lastActivity: new Date(1700000000000).toISOString(),
            status: "suspended",
          },
        },
      }),
      "utf-8",
    );

    const registry = new SessionRegistry(filePath);
    const loaded = registry.load();
    expect(loaded.get("chat-legacy")?.claudeSessionId).toBe("sess-legacy");
    expect(registry.getFreshStartNonce("chat-legacy")).toBeUndefined();
    const snapshot = registry.loadSnapshot();
    expect(snapshot.entries.get("chat-legacy")?.claudeSessionId).toBe("sess-legacy");
    expect(snapshot.freshStartNonces.size).toBe(0);
    // Unrelated save must not invent or drop mapping state.
    registry.flush(loaded);
    const reloaded = new SessionRegistry(filePath).load();
    expect(reloaded.get("chat-legacy")?.claudeSessionId).toBe("sess-legacy");
    expect(new SessionRegistry(filePath).loadSnapshot().freshStartNonces.size).toBe(0);
  });

  it("round-trips Reset fresh-start nonces and keeps them after mapping deletion", () => {
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
    });
    registry.flush(entries);
    const nonce = registry.rotateFreshStartNonce("chat-1");
    registry.flushOrThrow(new Map()); // mapping gone; tombstone remains
    registry.markResetNonceDurable("chat-1");
    registry.dispose();

    const loaded = new SessionRegistry(filePath).loadSnapshot();
    expect(loaded.entries.size).toBe(0);
    expect(loaded.freshStartNonces.get("chat-1")).toBe(nonce);

    // Unrelated mapping save for another chat must not erase the tombstone.
    const registry2 = new SessionRegistry(filePath);
    registry2.load();
    registry2.flush(
      makeEntries({
        "chat-other": { claudeSessionId: "sess-other", lastActivity: 1700002000000, status: "active" },
      }),
    );
    const afterOther = new SessionRegistry(filePath).loadSnapshot();
    expect(afterOther.entries.get("chat-other")?.claudeSessionId).toBe("sess-other");
    expect(afterOther.freshStartNonces.get("chat-1")).toBe(nonce);
  });

  it("retains one pending Reset nonce until markResetNonceDurable", () => {
    const registry = new SessionRegistry(filePath);
    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
      }),
    );
    const first = registry.rotateFreshStartNonce("chat-1");
    // A failed flush leaves the pending rotation — genuine retry must reuse it.
    expect(registry.rotateFreshStartNonce("chat-1")).toBe(first);
    registry.flushOrThrow(new Map());
    registry.markResetNonceDurable("chat-1");

    const loaded = new SessionRegistry(filePath).loadSnapshot();
    expect(loaded.entries.size).toBe(0);
    expect(loaded.freshStartNonces.get("chat-1")).toBe(first);
    // A later Reset attempt after durable success mints a new nonce.
    const second = registry.rotateFreshStartNonce("chat-1");
    expect(second).not.toBe(first);
  });

  it("stale debounced save cannot erase a Reset tombstone after flushOrThrow", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const withMapping = makeEntries({
      "chat-1": { claudeSessionId: "sess-old", lastActivity: 1700000000000, status: "active" },
    });
    registry.save(withMapping);
    const nonce = registry.rotateFreshStartNonce("chat-1");
    registry.flushOrThrow(new Map());
    registry.markResetNonceDurable("chat-1");
    // Advancing past the debounce window must not resurrect mapping or drop nonce.
    vi.advanceTimersByTime(1000);
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as {
      entries: Record<string, unknown>;
      freshStartNonces: Record<string, string>;
    };
    expect(raw.entries).toEqual({});
    expect(raw.freshStartNonces["chat-1"]).toBe(nonce);
    registry.dispose();
  });

  it("creates directory if it does not exist", () => {
    const deepPath = join(testDir, "a", "b", "c", "sessions.json");
    const registry = new SessionRegistry(deepPath);

    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );
    registry.dispose();

    expect(existsSync(deepPath)).toBe(true);
  });

  it("atomic write does not leave tmp file on success", () => {
    const registry = new SessionRegistry(filePath);
    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );
    registry.dispose();

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("debounced save writes after timeout", async () => {
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);

    // File should not exist immediately (debounced)
    expect(existsSync(filePath)).toBe(false);

    // Wait for debounce timeout (1 second + buffer)
    await new Promise((r) => setTimeout(r, 1200));

    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");
    expect(raw.freshStartNonces).toEqual({});

    registry.dispose();
  });

  it("flush cancels a pending debounced save", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);
    registry.flush(entries);
    vi.advanceTimersByTime(1000);

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");
    registry.dispose();
  });

  it("dispose flushes a pending debounced save", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);
    registry.dispose();
    // flush() already cancelled the timer — nothing more should fire.
    vi.advanceTimersByTime(1000);

    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");
  });

  it("dispose without a pending save writes nothing", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);

    registry.dispose();
    vi.advanceTimersByTime(1000);

    expect(existsSync(filePath)).toBe(false);
  });

  it("dispose does not roll back a fresher flush — save(old) -> flush(new) -> dispose() leaves new on disk", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const oldEntries = makeEntries({
      "chat-1": { claudeSessionId: "sess-old", lastActivity: 1700000000000, status: "active" },
    });
    const newEntries = makeEntries({
      "chat-1": { claudeSessionId: "sess-new", lastActivity: 1700000999999, status: "active" },
    });

    // Mimic the SessionManager shutdown path: a debounced save was queued
    // earlier, then shutdown calls flush({ immediate: true }) with the final
    // state, then dispose() tears the timer down.
    registry.save(oldEntries);
    registry.flush(newEntries);
    registry.dispose();
    vi.advanceTimersByTime(1000);

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-new");
  });

  it("logs persistence failures without throwing", () => {
    const parentAsFile = join(testDir, "not-a-directory");
    writeFileSync(parentAsFile, "file blocks mkdir", "utf-8");
    const { dest, read } = collectLogs();
    applyClientLoggerConfig({ level: "warn", format: "json", destination: dest });
    const registry = new SessionRegistry(join(parentAsFile, "sessions.json"));

    expect(() =>
      registry.flush(
        makeEntries({
          "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
        }),
      ),
    ).not.toThrow();

    expect(read()).toContain('"module":"session-registry"');
    expect(read()).toContain('"msg":"Failed to persist:');
  });

  it("logs non-Error persistence failures", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        mkdirSync: () => {
          throw "mkdir failed";
        },
      };
    });
    const loggerMod = await import("../cloud/observability/logger.js");
    const { dest, read } = collectLogs();
    loggerMod.applyClientLoggerConfig({ level: "warn", format: "json", destination: dest });
    const mod = await import("../runtime/session-registry.js");
    const registry = new mod.SessionRegistry(filePath);

    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );

    expect(read()).toContain("mkdir failed");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
