import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, isRecord, parseEvents, previewText } from "../events.js";
import { isShimTraceLine } from "../reporter.js";
import {
  closeOpenedRegularFile,
  type OpenedRegularFile,
  openNoFollowRegularFile,
  readOpenedRegularText,
} from "../safe-file.js";
import type { ProviderRunContext, ProviderRunOptions } from "./types.js";

const ALLOWED_ENV_KEYS = new Set([
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "USER",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

const SHELL_ENV_KEYS = [
  "BASH_ENV",
  "ENV",
  "FIRST_TREE_EVAL_CASE_ID",
  "FIRST_TREE_EVAL_EVENTS",
  "FIRST_TREE_EVAL_PHASE",
  "FIRST_TREE_EVAL_VERBOSE",
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "ZDOTDIR",
] as const;

const SYSTEM_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"] as const;

const LINUX_PROCESS_TREE_SUPERVISOR = String.raw`
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    code = ctypes.get_errno()
    sys.stderr.write(f"process containment unavailable: prctl failed with errno {code}\n")
    sys.exit(125)

def direct_children():
    children = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == os.getpid():
            continue
        try:
            stat = open(f"/proc/{pid}/stat", "r", encoding="utf-8").read()
            end = stat.rfind(")")
            fields = stat[end + 2:].split()
            if len(fields) > 1 and int(fields[1]) == os.getpid():
                children.append(pid)
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue
    return children

def signal_children(sig):
    for pid in direct_children():
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

def reap_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return

def terminate_descendants():
    term_deadline = time.monotonic() + 0.25
    while True:
        reap_children()
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid > 0:
                continue
        except ChildProcessError:
            return
        signal_children(signal.SIGTERM if time.monotonic() < term_deadline else signal.SIGKILL)
        time.sleep(0.01)

target = subprocess.Popen(sys.argv[1:], start_new_session=True)
try:
    target_code = target.wait()
finally:
    terminate_descendants()

normalized_code = target_code if target_code >= 0 else 128 + abs(target_code)
os.write(3, f"{normalized_code}\n".encode("ascii"))
os.close(3)
sys.exit(0)
`;

function configArg(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function maybeDefaultCodexHome(sourceEnv: NodeJS.ProcessEnv): string | undefined {
  if (sourceEnv.CODEX_HOME) return sourceEnv.CODEX_HOME;
  if (!sourceEnv.HOME) return undefined;
  const defaultCodexHome = join(sourceEnv.HOME, ".codex");
  return existsSync(defaultCodexHome) ? defaultCodexHome : undefined;
}

function pathParts(pathValue: string | undefined): readonly string[] {
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

function uniquePath(dirs: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    kept.push(dir);
  }
  return kept.join(delimiter);
}

export function codexProviderCommand(options: ProviderRunOptions, sourceEnv: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(options.bin)) return options.bin;
  for (const dir of pathParts(sourceEnv.PATH)) {
    const candidate = join(dir, options.bin);
    if (existsSync(candidate)) return candidate;
  }
  return options.bin;
}

export function codexProviderArgs(
  options: ProviderRunOptions,
  workspacePath: string,
  shellEnv: NodeJS.ProcessEnv,
): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "workspace-write",
    "--cd",
    workspacePath,
    "-c",
    "shell_environment_policy.inherit=none",
  ];
  for (const key of SHELL_ENV_KEYS) {
    const value = shellEnv[key];
    if (value !== undefined) {
      args.push("-c", configArg(`shell_environment_policy.set.${key}`, value));
    }
  }

  if (options.model !== null) {
    args.push("--model", options.model);
  }

  args.push(options.prompt);
  return args;
}

export function codexProviderEnv(
  options: ProviderRunOptions,
  context: ProviderRunContext,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const command = codexProviderCommand(options, sourceEnv);
  const providerHome = join(context.paths.runRoot, "provider-home");
  const providerTmp = join(context.paths.runRoot, "provider-tmp");
  const providerXdgCache = join(context.paths.runRoot, "provider-xdg-cache");
  const providerXdgConfig = join(context.paths.runRoot, "provider-xdg-config");
  for (const dir of [providerHome, providerTmp, providerXdgCache, providerXdgConfig]) {
    mkdirSync(dir, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }

  const codexHome = maybeDefaultCodexHome(sourceEnv);
  if (codexHome !== undefined) {
    env.CODEX_HOME = codexHome;
  }

  env.BASH_ENV = join(context.paths.shellEnvDir, "bash-env");
  env.ENV = join(context.paths.shellEnvDir, "sh-env");
  env.FIRST_TREE_EVAL_CASE_ID = options.caseId;
  env.FIRST_TREE_EVAL_EVENTS = context.paths.modelEventsPath;
  env.FIRST_TREE_EVAL_PHASE = "model";
  env.FIRST_TREE_EVAL_VERBOSE = options.verbose ? "1" : "0";
  env.HOME = providerHome;
  env.PATH = uniquePath([
    context.paths.binDir,
    dirname(process.execPath),
    isAbsolute(command) ? dirname(command) : null,
    ...SYSTEM_PATH_DIRS,
  ]);
  env.TEMP = providerTmp;
  env.TMP = providerTmp;
  env.TMPDIR = providerTmp;
  env.XDG_CACHE_HOME = providerXdgCache;
  env.XDG_CONFIG_HOME = providerXdgConfig;
  env.ZDOTDIR = context.paths.shellEnvDir;
  return env;
}

async function consumeCodexStdout(
  eventsPath: string,
  stream: NodeJS.ReadableStream,
  context: ProviderRunContext,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      appendEvent(eventsPath, {
        cwd: context.paths.workspacePath,
        event,
        type: "codex_event",
      });
      context.reporter.codexEvent(event);
    } catch {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stdout",
      });
      context.reporter.codexStdoutLine(line);
    }
  }
}

async function consumeStderr(
  eventsPath: string,
  stream: NodeJS.ReadableStream,
  context: ProviderRunContext,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!isShimTraceLine(line)) {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stderr",
      });
    }
    context.reporter.codexStderrLine(line);
  }
}

async function readContainmentReceipt(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  let length = 0;
  let oversized = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 64) {
      oversized = true;
    } else if (!oversized) {
      chunks.push(buffer);
    }
  }
  return oversized ? "" : Buffer.concat(chunks).toString("utf8");
}

function isReadableStream(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream | null,
): stream is NodeJS.ReadableStream {
  return stream !== null && typeof (stream as NodeJS.ReadableStream).read === "function";
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  context: ProviderRunContext,
  contained: boolean,
): Promise<number> {
  return await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      appendEvent(context.paths.eventsPath, {
        error: error.message,
        type: "codex_spawn_error",
      });
      context.reporter.codexSpawnError(error);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      appendEvent(context.paths.eventsPath, {
        exitCode: code ?? 1,
        signal,
        type: contained ? "codex_process_supervisor_closed" : "codex_process_closed",
      });
      if (!contained) context.reporter.codexProcessFinished(code ?? 1);
      resolve(code ?? 1);
    });
  });
}

function appendModelEvents(context: ProviderRunContext, receipt: OpenedRegularFile): void {
  let modelEvents: readonly unknown[];
  try {
    modelEvents = parseEvents(readOpenedRegularText(receipt));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    appendEvent(context.paths.eventsPath, {
      error: error instanceof Error ? error.message : String(error),
      type: "model_events_rejected",
    });
    return;
  }
  for (const modelEvent of modelEvents) {
    appendEvent(
      context.paths.eventsPath,
      isRecord(modelEvent)
        ? { ...modelEvent, eventProvenance: "model-writable" }
        : { event: modelEvent, eventProvenance: "model-writable", type: "model_event" },
    );
  }
}

export async function runCodexProvider(options: ProviderRunOptions, context: ProviderRunContext): Promise<number> {
  const command = codexProviderCommand(options);
  const env = codexProviderEnv(options, context);
  const args = codexProviderArgs(options, context.paths.workspacePath, env);
  if (options.containProcessTree === true && process.platform !== "linux") {
    throw new Error("Codex process-tree containment is supported only on Linux.");
  }
  const spawnCommand = options.containProcessTree === true ? "python3" : command;
  const spawnArgs =
    options.containProcessTree === true ? ["-I", "-c", LINUX_PROCESS_TREE_SUPERVISOR, command, ...args] : args;
  const modelEventsReceipt = openNoFollowRegularFile(context.paths.modelEventsPath);
  appendEvent(context.paths.eventsPath, {
    args,
    caseId: options.caseId,
    command,
    envKeys: Object.keys(env).sort(),
    processTreeContained: options.containProcessTree === true,
    sandbox: "workspace-write",
    type: "codex_run_started",
  });
  context.reporter.codexProcessStarted(args);

  try {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: context.paths.workspacePath,
      env,
      stdio: options.containProcessTree === true ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    const streamTasks: Promise<void>[] = [];
    if (child.stdout) streamTasks.push(consumeCodexStdout(context.paths.eventsPath, child.stdout, context));
    if (child.stderr) streamTasks.push(consumeStderr(context.paths.eventsPath, child.stderr, context));
    const containmentStream = child.stdio[3] ?? null;
    const containmentReceiptTask =
      options.containProcessTree === true && isReadableStream(containmentStream)
        ? readContainmentReceipt(containmentStream)
        : Promise.resolve("");

    const supervisorExitCode = await waitForChildExit(child, context, options.containProcessTree === true);
    await Promise.all(streamTasks);
    const containmentReceipt = await containmentReceiptTask;
    let exitCode = supervisorExitCode;
    if (options.containProcessTree === true) {
      if (supervisorExitCode !== 0 || !/^(0|[1-9][0-9]{0,2})\n$/.test(containmentReceipt)) {
        appendEvent(context.paths.eventsPath, {
          receiptPreview: previewText(containmentReceipt),
          supervisorExitCode,
          type: "codex_process_containment_failed",
        });
        throw new Error("Codex process-tree containment did not produce a trusted completion receipt.");
      }
      exitCode = Number(containmentReceipt.trim());
      appendEvent(context.paths.eventsPath, {
        exitCode,
        type: "codex_process_tree_reaped",
      });
      context.reporter.codexProcessFinished(exitCode);
    }
    appendModelEvents(context, modelEventsReceipt);

    appendEvent(context.paths.eventsPath, {
      caseId: options.caseId,
      exitCode,
      type: "codex_run_finished",
    });

    return exitCode;
  } finally {
    closeOpenedRegularFile(modelEventsReceipt);
  }
}
