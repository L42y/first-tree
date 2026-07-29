import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type RuntimeSessionTokenCleanupResult = "removed" | "missing" | "empty" | "mismatch";

export type RuntimeSessionTokenFileOptions = {
  lockAcquireTimeoutMs?: number;
  lockRetryDelayMs?: number;
};

/**
 * Owns the stable per-agent runtime-session token file.
 *
 * The token itself is the generation identity: a successful write returns its
 * SHA-256 digest for the owning AgentSlot to keep in memory. Both replacement
 * and compare-and-delete run under the same cross-process per-agent lock.
 */
export class RuntimeSessionTokenFile {
  readonly path: string;
  readonly lockPath: string;
  private readonly lockAcquireTimeoutMs: number;
  private readonly lockRetryDelayMs: number;

  constructor(path: string, options: RuntimeSessionTokenFileOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockAcquireTimeoutMs = options.lockAcquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  }

  persist(token: string): string {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new Error("Cannot persist an empty runtime session token.");
    }

    return this.withMutationLock(() => {
      this.writeAtomically(normalizedToken);
      return digestRuntimeSessionToken(normalizedToken);
    });
  }

  read(): string | undefined {
    try {
      const token = readFileSync(this.path, "utf8").trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  removeIfOwned(expectedDigest: string): RuntimeSessionTokenCleanupResult {
    return this.withMutationLock(() => {
      let token: string;
      try {
        token = readFileSync(this.path, "utf8").trim();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return "missing";
        throw new Error("Failed to read the runtime session token during owned cleanup.", { cause: error });
      }

      if (!token) return "empty";
      if (digestRuntimeSessionToken(token) !== expectedDigest) return "mismatch";

      rmSync(this.path);
      return "removed";
    });
  }

  private withMutationLock<T>(action: () => T): T {
    this.ensurePrivateDirectory();
    const descriptor = this.acquireMutationLock();

    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: action() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let releaseError: unknown;
    try {
      closeSync(descriptor);
      rmSync(this.lockPath);
    } catch (error) {
      releaseError = error;
    }

    if (!outcome.ok) {
      if (releaseError) {
        throw new AggregateError(
          [outcome.error, releaseError],
          "Runtime session token mutation and lock release both failed.",
        );
      }
      throw outcome.error;
    }
    if (releaseError) {
      throw new Error("Failed to release the runtime session token mutation lock.", { cause: releaseError });
    }
    return outcome.value;
  }

  private ensurePrivateDirectory(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  private acquireMutationLock(): number {
    const deadline = Date.now() + Math.max(0, this.lockAcquireTimeoutMs);

    while (true) {
      try {
        const descriptor = openSync(this.lockPath, "wx", 0o600);
        try {
          writeFileSync(descriptor, `${process.pid}\n`, "utf8");
        } catch (error) {
          closeSync(descriptor);
          rmSync(this.lockPath, { force: true });
          throw error;
        }
        return descriptor;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new Error("Failed to acquire the runtime session token mutation lock.", { cause: error });
        }

        // A pathname-only stale-lock delete cannot prove that the path still
        // names the lock it inspected. Leave every existing lock untouched;
        // bind fails unavailable and cleanup preserves the token on timeout.
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error("Timed out acquiring the runtime session token mutation lock.", { cause: error });
        }
        sleepSync(Math.min(Math.max(1, this.lockRetryDelayMs), remainingMs));
      }
    }
  }

  private writeAtomically(token: string): void {
    let temporaryPath: string | null = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.path);
      temporaryPath = null;
      chmodSync(this.path, 0o600);
    } finally {
      if (temporaryPath) rmSync(temporaryPath, { force: true });
    }
  }
}

export function digestRuntimeSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
}
