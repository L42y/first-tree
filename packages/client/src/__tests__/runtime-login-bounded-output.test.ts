import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runCodexBrowserLogin } from "../runtime/codex-login.js";
import { AUTH_URL_TOKEN_MAX, createAuthUrlScanner, LOGIN_STDERR_TAIL_MAX } from "../runtime/runtime-login.js";

/**
 * Regression cover for #1720: a provider login may stream for the full
 * five-minute browser-OAuth window, so neither the retained state nor the
 * scanning work may grow with the volume of output.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf-8"));
  }
  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf-8"));
  }
  close(code: number): void {
    this.emit("close", code);
  }
}

function fakeSpawn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => child) as unknown as typeof import("node:child_process").spawn;
}

describe("auth URL scanner keeps retained state bounded", () => {
  it("retains nothing beyond the current partial token across a flood of chunks", () => {
    const scanner = createAuthUrlScanner();
    for (let i = 0; i < 5_000; i++) {
      expect(scanner.push(`waiting for sign-in chunk ${i} `)).toBeNull();
      expect(scanner.retainedChars()).toBe(0);
    }
  });

  it("caps an over-long unterminated token instead of growing without bound", () => {
    const scanner = createAuthUrlScanner();
    // A single 200 KB run of non-whitespace: retention must stay at the cap.
    for (let i = 0; i < 200; i++) {
      scanner.push("x".repeat(1_000));
      expect(scanner.retainedChars()).toBeLessThanOrEqual(AUTH_URL_TOKEN_MAX);
    }
    // The discarded token must not poison the next, real one.
    scanner.push(" https://auth.openai.com/ok\n");
    expect(scanner.retainedChars()).toBe(0);
  });

  it("recognises a URL split across chunk boundaries", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("If it didn't open, visit https://auth.open")).toBeNull();
    expect(scanner.push("ai.com/oauth/authorize?x=1")).toBeNull();
    expect(scanner.push("\nnext line\n")).toBe("https://auth.openai.com/oauth/authorize?x=1");
  });

  it("still skips the CLI's own loopback callback server", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("Starting local login server on http://localhost:1455.\n")).toBeNull();
    expect(scanner.push("listening on http://127.0.0.1:1455\n")).toBeNull();
    expect(scanner.push("visit https://auth.openai.com/x\n")).toBe("https://auth.openai.com/x");
  });

  it("stops scanning, stops growing and stops reporting once a URL is found", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("visit https://auth.openai.com/x\n")).toBe("https://auth.openai.com/x");
    const scannedAtHit = scanner.scannedChars();
    for (let i = 0; i < 1_000; i++) {
      expect(scanner.push(`https://auth.example/later-${i} and a very long unterminated tail`)).toBeNull();
      expect(scanner.retainedChars()).toBe(0);
    }
    expect(scanner.scannedChars()).toBe(scannedAtHit);
  });

  it("examines a large stream once, not once per accumulated buffer", () => {
    // Roughly 4 MB with no URL. Re-splitting the accumulated buffer on every
    // chunk would examine tens of GB here; an incremental parser examines each
    // character exactly once, which the scan counter asserts directly rather
    // than inferring it from how fast the test ran.
    const scanner = createAuthUrlScanner();
    const chunk = `${"provider chatter ".repeat(12)}\n`;
    const chunks = 20_000;
    for (let i = 0; i < chunks; i++) scanner.push(chunk);
    expect(scanner.scannedChars()).toBe(chunk.length * chunks);
    expect(scanner.retainedChars()).toBe(0);
  });
});

describe("runBrowserLogin does not retain the provider's output", () => {
  it("reports a cross-chunk external URL exactly once while streaming every chunk", async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const raw: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      onRawOutput: (chunk) => raw.push(chunk),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("Starting local login server on http://localhost:1455.\n");
    child.emitStdout("If it didn't open, visit https://auth.open");
    child.emitStdout("ai.com/oauth?x=1\n");
    for (let i = 0; i < 500; i++) child.emitStdout(`still waiting ${i} https://auth.example/other-${i}\n`);
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://auth.openai.com/oauth?x=1"]);
    // Chunks keep streaming to the diagnostic hook; the login itself keeps none.
    expect(raw).toHaveLength(503);
  });

  it("keeps only a bounded stderr tail in the failure message", async () => {
    const child = new FakeChild();
    const run = runCodexBrowserLogin({ binary: "/bundled/codex", spawnFn: fakeSpawn(child) });

    for (let i = 0; i < 200; i++) child.emitStderr(`noisy provider diagnostic line ${i}\n`);
    child.emitStderr("could not open a browser on this host\n");
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.length).toBeLessThanOrEqual(LOGIN_STDERR_TAIL_MAX);
    expect(outcome.error).toContain("could not open a browser on this host");
  });
});
