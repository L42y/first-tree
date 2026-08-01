import type { ChildProcess } from "node:child_process";
import type { ProviderProcessSupervisor } from "../../runtime/provider-process-supervisor.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 8_000;
const LINE_SEPARATOR = "\n";
const LINE_SEPARATOR_CODE = LINE_SEPARATOR.charCodeAt(0);
const CARRIAGE_RETURN_CODE = "\r".charCodeAt(0);

export type PiRpcResponse = {
  success: boolean;
  error?: string;
  data?: unknown;
};

export type PiRpcEventCallback = (event: Record<string, unknown>) => void;

export type PiRpcClientOptions = {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  supervisor: ProviderProcessSupervisor;
  label?: string;
  requestTimeoutMs?: number;
  onEvent?: PiRpcEventCallback;
  onLog?: (message: string) => void;
};

export class PiRpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcTransportError";
  }
}

type PendingRequest = {
  resolve: (value: PiRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Split buffered stdout on LF only. U+2028/U+2029 inside JSON strings are
 * preserved — we never treat them as line boundaries.
 */
export function splitPiJsonlBuffer(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer.charCodeAt(index) !== LINE_SEPARATOR_CODE) continue;
    let end = index;
    if (end > start && buffer.charCodeAt(end - 1) === CARRIAGE_RETURN_CODE) end -= 1;
    if (end > start) frames.push(buffer.slice(start, end));
    start = index + 1;
  }
  return { frames, rest: buffer.slice(start) };
}

export function buildPiRpcArgs(input: {
  sessionId: string;
  sessionDir: string;
  skillsDir: string;
  model?: string;
}): string[] {
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--skill",
    input.skillsDir,
    "--no-prompt-templates",
    "--no-approve",
    "--session-id",
    input.sessionId,
    "--session-dir",
    input.sessionDir,
  ];
  if (input.model) args.push("--model", input.model);
  return args;
}

export class PiRpcClient {
  private readonly requestTimeoutMs: number;
  private readonly onEvent?: PiRpcEventCallback;
  private readonly onLog?: (message: string) => void;
  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";

  private constructor(
    child: ChildProcess,
    exited: Promise<void>,
    options: Pick<PiRpcClientOptions, "requestTimeoutMs" | "onEvent" | "onLog">,
  ) {
    this.child = child;
    this.exited = exited;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.onLog = options.onLog;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      this.failAllPending(new PiRpcTransportError(error.message));
      this.closed = true;
    });
    child.on("close", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderrTail.trim();
        const suffix = detail ? ` stderr: ${detail}` : "";
        this.failAllPending(
          new PiRpcTransportError(
            `pi rpc exited${code === null ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}.${suffix}`,
          ),
        );
      }
      this.closed = true;
      this.child = null;
    });
  }

  static async start(options: PiRpcClientOptions): Promise<PiRpcClient> {
    const supervised = options.supervisor.spawn({
      command: options.binary,
      args: [...options.args],
      label: options.label ?? "pi rpc",
      options: {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    });
    return new PiRpcClient(supervised.child, supervised.exited, options);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request(
    command: string,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<PiRpcResponse> {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new PiRpcTransportError("pi rpc transport is closed");
    }
    const id = String(this.nextId++);
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcTransportError(`pi rpc request timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const payload: Record<string, unknown> = { type: "request", id, command };
        if (params !== undefined) payload.params = params;
        this.writeLine(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new PiRpcTransportError(String(error)));
      }
    });
  }

  async prompt(message: string): Promise<PiRpcResponse> {
    return this.request("prompt", { message });
  }

  async steer(message: string): Promise<PiRpcResponse> {
    return this.request("steer", { message });
  }

  async abort(): Promise<PiRpcResponse> {
    return this.request("abort");
  }

  async getState(): Promise<PiRpcResponse> {
    return this.request("get_state");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.child?.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.end();
      }
    } catch {
      // stdin may already be closed.
    }
    if (this.exited) {
      try {
        await this.exited;
      } catch {
        // Process exit observation is best-effort during close.
      }
    }
    this.failAllPending(new PiRpcTransportError("pi rpc transport closed"));
    this.child = null;
  }

  private writeLine(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new PiRpcTransportError("pi rpc stdin is not writable");
    stdin.write(`${JSON.stringify(payload)}${LINE_SEPARATOR}`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const { frames, rest } = splitPiJsonlBuffer(this.stdoutBuffer);
    this.stdoutBuffer = rest;
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(frame);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.onLog?.(`pi rpc ignored non-object frame: ${frame.slice(0, 200)}`);
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      this.onLog?.(`pi rpc ignored invalid JSON frame: ${frame.slice(0, 200)}`);
      return;
    }

    if (parsed.type === "response") {
      const id = parsed.id;
      const key = typeof id === "string" || typeof id === "number" ? String(id) : null;
      if (!key) return;
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      const success = parsed.success === true;
      const error =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
      pending.resolve({
        success,
        ...(error ? { error } : {}),
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
        ...(parsed.result !== undefined ? { data: parsed.result } : {}),
      });
      return;
    }

    this.onEvent?.(parsed);
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
