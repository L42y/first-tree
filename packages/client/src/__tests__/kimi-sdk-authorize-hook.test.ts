import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end regression through the REAL patched `@botiverse/kimi-code-sdk`
 * bundle: a live harness + core session + the actual RPC/event bridge, driven
 * by a local mock OpenAI-compatible provider (no external network, no
 * credentials). It proves the replay-fence host hook is invoked at the SDK's
 * awaited authorize boundary and that a hook failure blocks the unsafe tool
 * BEFORE its effect executes — the guarantee the (async, error-swallowing)
 * live-event listener path cannot provide.
 */

type ToolCallSpec = { id: string; name: string; arguments: string };

class MockOpenAIProvider {
  private server: Server | null = null;
  port = 0;
  requests: Array<{ stream: boolean; toolNames: string[] }> = [];
  private step = 0;

  constructor(private readonly toolCall: ToolCallSpec) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("mock provider has no address");
    this.port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !req.url?.includes("chat/completions")) {
      res.writeHead(404).end("{}");
      return;
    }
    const body = await this.readBody(req);
    const parsed = JSON.parse(body) as { stream?: boolean; tools?: Array<{ function?: { name?: string } }> };
    this.requests.push({
      stream: parsed.stream === true,
      toolNames: (parsed.tools ?? []).map((tool) => tool.function?.name ?? ""),
    });
    this.step += 1;
    const withToolCall = this.step === 1;
    if (parsed.stream === true) {
      this.respondSse(res, withToolCall);
    } else {
      this.respondJson(res, withToolCall);
    }
  }

  private respondJson(res: ServerResponse, withToolCall: boolean): void {
    const message = withToolCall
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: this.toolCall.id,
              type: "function",
              function: { name: this.toolCall.name, arguments: this.toolCall.arguments },
            },
          ],
        }
      : { role: "assistant", content: "turn done" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, message, finish_reason: withToolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }

  private respondSse(res: ServerResponse, withToolCall: boolean): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    if (withToolCall) {
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: this.toolCall.id,
                type: "function",
                function: { name: this.toolCall.name, arguments: "" },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: this.toolCall.arguments } }] }, null));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: "turn done" }, null));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => resolvePromise(body));
      req.on("error", rejectPromise);
    });
  }
}

type SdkHarness = {
  createSession(options: Record<string, unknown>): Promise<{
    id: string;
    prompt(input: string): Promise<void>;
    onEvent(listener: (event: { type: string }) => void): () => void;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
};

type SdkTestSession = Awaited<ReturnType<SdkHarness["createSession"]>>;

async function runTurnToEnd(session: SdkTestSession, events: string[], prompt: string): Promise<void> {
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolvePromise) => {
    resolveEnded = resolvePromise;
  });
  const unsubscribe = session.onEvent((event) => {
    events.push(event.type);
    if (event.type === "turn.ended") resolveEnded();
  });
  try {
    await session.prompt(prompt);
    await Promise.race([
      ended,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn never ended")), 30_000)),
    ]);
  } finally {
    unsubscribe();
  }
}

let homeDir: string;
let workDir: string;
let provider: MockOpenAIProvider;
let harness: SdkHarness | null = null;

const MARKER_NAME = "authorize-hook-effect-marker.txt";

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "kimi-sdk-hook-home-"));
  workDir = mkdtempSync(join(tmpdir(), "kimi-sdk-hook-work-"));
  provider = new MockOpenAIProvider({
    id: "call_bash_marker",
    name: "Bash",
    arguments: JSON.stringify({ command: `touch ${MARKER_NAME}` }),
  });
  await provider.start();
  writeFileSync(
    join(homeDir, "config.toml"),
    [
      'default_provider = "mock"',
      'default_model = "mock-model"',
      "telemetry = false",
      "",
      "[providers.mock]",
      'type = "openai"',
      `base_url = "http://127.0.0.1:${provider.port}/v1"`,
      'api_key = "mock-key"',
      "",
      '[models."mock-model"]',
      'provider = "mock"',
      'model = "mock-model"',
      "max_context_size = 131072",
      'capabilities = ["tool_use"]',
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterEach(async () => {
  delete (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall;
  if (harness) {
    await harness.close().catch(() => {});
    harness = null;
  }
  await provider.stop();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function createHarness(): Promise<SdkHarness> {
  const require = createRequire(import.meta.url);
  const sdk = (await import(
    require.resolve("@botiverse/kimi-code-sdk", {
      paths: [join(process.cwd(), "src", "__tests__")],
    })
  )) as { createKimiHarness(options: Record<string, unknown>): SdkHarness };
  return sdk.createKimiHarness({
    identity: { userAgentProduct: "first-tree-test", version: "0.0.0" },
    uiMode: "first-tree",
    homeDir,
  });
}

describe("patched SDK authorize boundary (real bundle + mock provider)", () => {
  it("invokes the host hook with session/agent identity and blocks the unsafe effect when it throws", async () => {
    const hookCalls: Array<{ sessionId?: string; agentId?: string; toolName: string }> = [];
    (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall = (info: {
      sessionId?: string;
      agentId?: string;
      toolName: string;
    }) => {
      hookCalls.push(info);
      if (info.toolName === "Bash") throw new Error("durable fence failed");
    };

    harness = await createHarness();
    const session = await harness.createSession({ workDir, permission: "yolo" });
    const events: string[] = [];
    await runTurnToEnd(session, events, "run the bash tool, then finish");
    await session.close();

    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0]).toMatchObject({ sessionId: session.id, agentId: "main", toolName: "Bash" });
    // The decisive assertion: the hook failure blocked the call at the
    // authorize boundary, so the Bash effect never executed.
    expect(existsSync(join(workDir, MARKER_NAME))).toBe(false);
    // The turn continued past the blocked tool and ended on the main agent.
    expect(events).toContain("tool.call.started");
    expect(events).toContain("turn.ended");
  }, 60_000);

  it("lets the effect run when the host hook allows the call", async () => {
    (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall = () => {};

    harness = await createHarness();
    const session = await harness.createSession({ workDir, permission: "yolo" });
    await runTurnToEnd(session, [], "run the bash tool, then finish");
    await session.close();

    expect(existsSync(join(workDir, MARKER_NAME))).toBe(true);
  }, 60_000);
});
