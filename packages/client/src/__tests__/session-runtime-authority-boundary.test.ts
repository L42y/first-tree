import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sessionRuntimeSourcePath = join(here, "..", "runtime", "session-runtime.ts");

/** Strip comments so field names in JSDoc / line comments are not false positives. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, " ").trim());
}

describe("SessionRuntime authority boundary", () => {
  const source = stripComments(readFileSync(sessionRuntimeSourcePath, "utf8"));

  it("does not reach projection ledgers except through intent methods", () => {
    const forbidden = [
      /this\.projection\.sessions\s*\./g,
      /this\.projection\.evictedMappings\s*\./g,
      /this\.projection\.currentTrigger\s*\./g,
      /this\.projection\.sessionRuntimeStates\s*\./g,
      /this\.projection\.lastReportedStates\s*\./g,
      /this\.projection\.runtimeProofRecoveryChats\s*\./g,
      /this\.projection\.lastTreeResolveAttemptAt\b/g,
      /this\.projection\.lastReportedRuntimeState\b/g,
    ];
    expect(forbidden.flatMap((pattern) => matches(source, pattern))).toEqual([]);
  });

  it("does not reach Reset/replay ledgers except through intent methods", () => {
    const forbidden = [
      /this\.resetReplay\.terminatingChats\s*\./g,
      /this\.resetReplay\.terminatePersistFailures\b/g,
      /this\.resetReplay\.awaitingResetFenceRelease\b/g,
      /this\.resetReplay\.resetGenerations\s*\./g,
      /this\.resetReplay\.postFenceRecoveryDebt\s*\./g,
      /this\.resetReplay\.replayFence\b/g,
    ];
    expect(forbidden.flatMap((pattern) => matches(source, pattern))).toEqual([]);
  });

  it("does not reach route-teardown ledgers except through intent methods", () => {
    const forbidden = [
      /this\.routeTeardown\.pendingTeardowns\s*\./g,
      /this\.routeTeardown\.quarantinedSessions\s*\./g,
      /this\.routeTeardown\.routeProducers\s*\./g,
    ];
    expect(forbidden.flatMap((pattern) => matches(source, pattern))).toEqual([]);
  });

  it("does not reach slot-scheduler ledgers except through intent methods", () => {
    const forbidden = [
      /this\.slotScheduler\.pendingQueue\s*\./g,
      /this\.slotScheduler\.admissionGenerations\s*\./g,
      /this\.slotScheduler\.retryFlights\s*\./g,
      /this\.slotScheduler\.activeCount\b/g,
    ];
    expect(forbidden.flatMap((pattern) => matches(source, pattern))).toEqual([]);
  });

  it("does not write migrated SessionEntry retry/route fields", () => {
    const forbidden = [
      /\bentry\.deferredMessages\b/g,
      /\bentry\.retryTimer\b/g,
      /\bentry\.routeInjectReady\b/g,
      /\bentry\.routeTransition\s*=/g,
      /\bentry\.routeTransitionGeneration\b/g,
      /\bentry\.retryHeadMessage\s*=/g,
      /\bentry\.retryAttempt\s*=/g,
      /\bentry\.retryNextAt\s*=/g,
      /\bentry\.lastRetry\w*\s*=/g,
      /\bentry\.retryFromEvicted\s*=/g,
    ];
    expect(forbidden.flatMap((pattern) => matches(source, pattern))).toEqual([]);
  });
});
