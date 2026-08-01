import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiRpcArgs, PiRpcClient } from "../handlers/pi/rpc-client.js";
import type { ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";

const runHostSmoke = process.env.FT_PI_HOST_SMOKE === "1";

function hostSupervisor(): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      const child = spawn(spec.command, [...spec.args], {
        ...spec.options,
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(runHostSmoke)("Pi host smoke (real 0.83.x)", () => {
  it("correlates command responses, streams text once, normalizes usage, settles, exits cleanly", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ft-pi-host-smoke-"));
    roots.push(sessionDir);
    const sessionId = `ftsmoke${Date.now().toString(16)}`.slice(0, 32);
    const events: string[] = [];
    let assistantText = "";
    let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

    const client = await PiRpcClient.start({
      binary: process.env.PI_BIN ?? "pi",
      args: buildPiRpcArgs({
        sessionId,
        sessionDir,
        skillsDir: join(sessionDir, "skills"),
      }),
      cwd: sessionDir,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      supervisor: hostSupervisor(),
      settlementTimeoutMs: 180_000,
      onEvent(event) {
        events.push(String(event.type));
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            assistantText += ame.delta;
          }
        }
        if (event.type === "message_end" || event.type === "turn_end") {
          const message = event.message as
            | { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } }
            | undefined;
          if (message?.role === "assistant" && message.usage) {
            usage = {
              inputTokens: message.usage.input ?? 0,
              cachedInputTokens: message.usage.cacheRead ?? 0,
              outputTokens: message.usage.output ?? 0,
            };
          }
        }
      },
    });

    const state = await client.getState();
    expect(state.command).toBe("get_state");
    expect(state.success).toBe(true);
    expect((state.data as { sessionId?: string } | undefined)?.sessionId).toBe(sessionId);

    const prompt = await client.prompt("Reply with exactly: FT_PI_SMOKE_OK");
    expect(prompt.command).toBe("prompt");
    expect(prompt.success).toBe(true);

    await client.waitForSettled();
    expect(events).toContain("agent_settled");
    expect(assistantText.length).toBeGreaterThan(0);
    expect(events.filter((type) => type === "message_update").length).toBeGreaterThan(0);
    if (!usage) throw new Error("expected normalized usage from assistant message");
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);

    await client.close();
    expect(client.isClosed).toBe(true);
  }, 240_000);
});
