import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReplayFenceEntry, ReplayFenceError, ReplayFenceStore } from "../runtime/replay-fence.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "replay-fence-test-"));
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function entry(overrides: Partial<ReplayFenceEntry> = {}): ReplayFenceEntry {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    provider: "kimi-code",
    toolName: "Write",
    toolUseId: "agent-0:tool-1",
    fencedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ReplayFenceStore", () => {
  it("persists a fence crash-safely and reloads it in a fresh process view", () => {
    const path = join(root, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();
    store.fence(entry());

    const reloaded = new ReplayFenceStore(path);
    reloaded.load();
    expect(reloaded.isFenced("chat-1", "msg-1")).toBe(true);
    expect(reloaded.isFenced("chat-1", "msg-2")).toBe(false);
    expect(reloaded.snapshot()[0]).toMatchObject({
      chatId: "chat-1",
      messageId: "msg-1",
      provider: "kimi-code",
      toolName: "Write",
      toolUseId: "agent-0:tool-1",
    });
  });

  it("clears a fence durably after settlement", () => {
    const path = join(root, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();
    store.fence(entry());
    store.clear("chat-1", "msg-1");

    const reloaded = new ReplayFenceStore(path);
    reloaded.load();
    expect(reloaded.isFenced("chat-1", "msg-1")).toBe(false);
  });

  it("keeps independent (chat, message) fences isolated", () => {
    const path = join(root, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();
    store.fence(entry());
    store.fence(entry({ chatId: "chat-2" }));
    store.fence(entry({ messageId: "msg-2" }));
    store.clear("chat-1", "msg-1");

    expect(store.isFenced("chat-1", "msg-1")).toBe(false);
    expect(store.isFenced("chat-2", "msg-1")).toBe(true);
    expect(store.isFenced("chat-1", "msg-2")).toBe(true);
  });

  it("treats a missing file as an empty store", () => {
    const store = new ReplayFenceStore(join(root, "absent.json"));
    store.load();
    expect(store.isFenced("chat-1", "msg-1")).toBe(false);
  });

  it("fails closed on a corrupted store file", () => {
    const path = join(root, "fence.json");
    writeFileSync(path, "{ not json", "utf-8");
    const store = new ReplayFenceStore(path);
    expect(() => store.load()).toThrow(ReplayFenceError);
  });

  it("fails closed on an unsupported store version", () => {
    const path = join(root, "fence.json");
    writeFileSync(path, JSON.stringify({ version: 99, entries: {} }), "utf-8");
    const store = new ReplayFenceStore(path);
    expect(() => store.load()).toThrow(/unsupported version/);
  });

  it("fails closed on a malformed entry whose key does not match its identity", () => {
    const path = join(root, "fence.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: { "chat-1 msg-1": { ...entry(), messageId: "msg-other" } },
      }),
      "utf-8",
    );
    const store = new ReplayFenceStore(path);
    expect(() => store.load()).toThrow(/malformed entry/);
  });

  it("throws on persist failure and does not keep the in-memory fence", () => {
    const blocked = join(root, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);
    const path = join(blocked, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();

    expect(() => store.fence(entry())).toThrow(ReplayFenceError);
    expect(store.isFenced("chat-1", "msg-1")).toBe(false);
    chmodSync(blocked, 0o700);
  });

  it("restores the in-memory fence when a clear fails to persist", () => {
    const path = join(root, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();
    store.fence(entry());
    chmodSync(root, 0o500);

    expect(() => store.clear("chat-1", "msg-1")).toThrow(ReplayFenceError);
    expect(store.isFenced("chat-1", "msg-1")).toBe(true);
    chmodSync(root, 0o700);
  });

  it("does not rewrite the file when fencing an already-fenced delivery", () => {
    const path = join(root, "fence.json");
    const store = new ReplayFenceStore(path);
    store.load();
    store.fence(entry());
    const before = readFileSync(path, "utf-8");
    store.fence(entry({ toolName: "Bash" }));
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});
