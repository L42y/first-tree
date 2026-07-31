import type { spawn } from "node:child_process";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "./runtime-login.js";

/**
 * Grok Build browser-OAuth login on top of the shared {@link runBrowserLogin}
 * plumbing: `<grok-binary> login` opens the provider's sign-in page on the
 * host, Grok's own callback completes the exchange, and the CLI writes its
 * local credential store itself. First Tree never sees the token; it only
 * observes the process outcome and re-probes capabilities. (`grok login
 * --device-auth` exists for headless hosts but stays operator-run; the
 * in-product flow always drives the browser path.)
 */

export type GrokBrowserLoginOptions = {
  /** Absolute path to the grok binary the runtime resolved (external-only). */
  binary: string;
  /** Environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Fired at most once with a fallback auth URL parsed from output. */
  onAuthUrl?: (url: string) => void;
  /** Raw, ANSI-stripped output, for diagnostics. */
  onRawOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

/** Spawn `<grok-binary> login` (official browser OAuth on the host). */
export function runGrokBrowserLogin(options: GrokBrowserLoginOptions): Promise<LoginOutcome> {
  return runBrowserLogin({
    command: options.binary,
    args: ["login"],
    label: "grok login",
    env: options.env,
    onAuthUrl: options.onAuthUrl,
    onRawOutput: options.onRawOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });
}
