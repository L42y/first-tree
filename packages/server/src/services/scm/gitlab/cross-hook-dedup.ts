import { createHash } from "node:crypto";
import { createLogger } from "../../../observability/index.js";

const log = createLogger("GitlabCrossHookDedup");

export const GITLAB_CROSS_HOOK_DEDUP_TTL_MS = 60_000;
const MAX_GITLAB_CROSS_HOOK_DEDUP_ENTRIES = 10_000;

export type GitlabHookSource = "system" | "project";

type JsonObject = Record<string, unknown>;

type GitlabCrossHookDedupEntry = {
  hookSource: GitlabHookSource;
  processedAt: number;
};

const successfulEvents = new Map<string, GitlabCrossHookDedupEntry>();
const connectionTails = new Map<string, Promise<void>>();

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;

  const canonical: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    canonical[key] = canonicalizeJson(nestedValue);
  }
  return canonical;
}

function pruneExpired(now: number): void {
  for (const [fingerprint, entry] of successfulEvents) {
    if (now - entry.processedAt <= GITLAB_CROSS_HOOK_DEDUP_TTL_MS) break;
    successfulEvents.delete(fingerprint);
  }
}

export function buildGitlabCrossHookFingerprint(input: {
  connectionId: string;
  projectId: number;
  mrIid: number;
  action: string | null;
  updatedAt: string | null;
  oldrev: string | null;
  changes: JsonObject | null;
}): string | null {
  const hasChanges = input.changes !== null && Object.keys(input.changes).length > 0;
  if (!input.updatedAt && !input.oldrev && !hasChanges) return null;

  const canonical = canonicalizeJson({
    connectionId: input.connectionId,
    projectId: input.projectId,
    mrIid: input.mrIid,
    action: input.action,
    updatedAt: input.updatedAt,
    oldrev: input.oldrev,
    changes: hasChanges ? input.changes : null,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function isGitlabCrossHookDuplicate(input: {
  fingerprint: string;
  hookSource: GitlabHookSource;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const entry = successfulEvents.get(input.fingerprint);
  if (!entry) return false;
  if (now - entry.processedAt > GITLAB_CROSS_HOOK_DEDUP_TTL_MS) {
    successfulEvents.delete(input.fingerprint);
    return false;
  }
  return entry.hookSource !== input.hookSource;
}

export function rememberSuccessfulGitlabHookEvent(input: {
  fingerprint: string;
  hookSource: GitlabHookSource;
  processedAt?: number;
}): void {
  const processedAt = input.processedAt ?? Date.now();
  pruneExpired(processedAt);

  if (!successfulEvents.has(input.fingerprint) && successfulEvents.size >= MAX_GITLAB_CROSS_HOOK_DEDUP_ENTRIES) {
    const oldestFingerprint = successfulEvents.keys().next().value;
    if (typeof oldestFingerprint === "string") {
      successfulEvents.delete(oldestFingerprint);
      log.warn(
        { metric: "gitlab_cross_hook_dedup_evicted_total" },
        "evicted GitLab cross-hook dedup entry at capacity",
      );
    }
  }

  successfulEvents.delete(input.fingerprint);
  successfulEvents.set(input.fingerprint, {
    hookSource: input.hookSource,
    processedAt,
  });
}

/**
 * Keep same-process requests for one connection ordered through the database
 * transaction and the post-commit cache write. Cross-process delivery remains
 * deliberately best-effort.
 */
export async function withGitlabCrossHookDedupFence<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = connectionTails.get(connectionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  connectionTails.set(connectionId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (connectionTails.get(connectionId) === current) {
      connectionTails.delete(connectionId);
    }
  }
}

export function resetGitlabCrossHookDedupForTests(): void {
  successfulEvents.clear();
  connectionTails.clear();
}
