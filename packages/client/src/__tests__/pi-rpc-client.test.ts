import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiRpcArgs, PiRpcClient, splitPiJsonlBuffer } from "../handlers/pi/rpc-client.js";
import type { ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";

const LINE_SEP = "\u2028";
const PARA_SEP = "\u2029";

const RPC_CHILD_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  const req = JSON.parse(line);
  const id = req.id;
  if (req.command === "get_state") {
    write({ type: "response", id, success: true });
    return;
  }
  if (req.command === "prompt") {
    write({ type: "response", id, success: true });
    if (mode === "credential") {
      write({ type: "response", id: "late", success: false, error: "missing credentials" });
      return;
    }
    write({ type: "message_update", update: { type: "text_delta", delta: "hello" } });
    if (mode === "agent_end_only") {
      write({ type: "agent_end" });
      return;
    }
    if (mode === "abort_reorder") {
      setTimeout(() => write({ type: "agent_settled" }), 30);
      return;
    }
    write({ type: "agent_settled", usage: { inputTokens: 3, outputTokens: 2 } });
    return;
  }
  if (req.command === "steer") {
    write({ type: "response", id, success: true });
    return;
  }
  if (req.command === "abort") {
    write({ type: "response", id, success: true });
    if (mode === "abort_reorder") return;
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "response", id, success: false, error: "unknown command" });
});
`;

function supervisor(): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      const child = spawn(process.execPath, ["-e", RPC_CHILD_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
        },
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
});

describe("splitPiJsonlBuffer", () => {
  it("splits on LF only and preserves U+2028/U+2029 inside JSON strings", () => {
    const payload = { type: "event", text: `a${LINE_SEP}b${PARA_SEP}c` };
    const buffer = `${JSON.stringify(payload)}\nrest`;
    const { frames, rest } = splitPiJsonlBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toEqual(payload);
    expect(rest).toBe("rest");
  });

  it("strips trailing CR before LF", () => {
    const { frames } = splitPiJsonlBuffer('{"type":"response","id":"1","success":true}\r\n');
    expect(frames).toEqual(['{"type":"response","id":"1","success":true}']);
  });
});

describe("buildPiRpcArgs", () => {
  it("builds the rpc offline session contract", () => {
    expect(
      buildPiRpcArgs({
        sessionId: "abc",
        sessionDir: "/tmp/sessions",
        skillsDir: "/tmp/skills",
        model: "gpt-test",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "/tmp/skills",
      "--no-prompt-templates",
      "--no-approve",
      "--session-id",
      "abc",
      "--session-dir",
      "/tmp/sessions",
      "--model",
      "gpt-test",
    ]);
  });
});

describe("PiRpcClient", () => {
  it("routes responses by id and emits events", async () => {
    const events: Record<string, unknown>[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onEvent: (event) => events.push(event),
    });
    const state = await client.getState();
    expect(state.success).toBe(true);
    const prompt = await client.prompt("hi");
    expect(prompt.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    expect(events.some((event) => event.type === "agent_settled")).toBe(true);
    await client.close();
  });

  it("waits for agent_settled rather than agent_end for completion events", async () => {
    process.env.FT_PI_TEST_MODE = "agent_end_only";
    const events: string[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onEvent: (event) => events.push(String(event.type)),
    });
    await client.prompt("hi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain("agent_end");
    expect(events).not.toContain("agent_settled");
    await client.close();
  });

  it("handles abort response before agent_settled", async () => {
    process.env.FT_PI_TEST_MODE = "abort_reorder";
    const events: string[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onEvent: (event) => events.push(String(event.type)),
    });
    await client.prompt("hi");
    const abort = await client.abort();
    expect(abort.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((type) => type === "agent_settled").length).toBeGreaterThanOrEqual(1);
    await client.close();
  });
});
