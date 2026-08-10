import { afterEach, describe, expect, it } from "vitest";
import {
  buildGitlabCrossHookFingerprint,
  GITLAB_CROSS_HOOK_DEDUP_TTL_MS,
  isGitlabCrossHookDuplicate,
  rememberSuccessfulGitlabHookEvent,
  resetGitlabCrossHookDedupForTests,
  withGitlabCrossHookDedupFence,
} from "../services/scm/gitlab/cross-hook-dedup.js";

const occurrence = {
  connectionId: "connection-1",
  projectId: 99,
  mrIid: 7,
  action: "update",
  updatedAt: "2026-07-28T10:00:00.000Z",
  oldrev: "abc123",
};

describe("GitLab cross-hook dedup", () => {
  afterEach(() => {
    resetGitlabCrossHookDedupForTests();
  });

  it("builds the same fingerprint for canonically equal change objects", () => {
    const first = buildGitlabCrossHookFingerprint({
      ...occurrence,
      changes: {
        title: { previous: "Before", current: "After" },
        labels: { previous: [], current: [{ title: "ready", color: "#fff" }] },
      },
    });
    const second = buildGitlabCrossHookFingerprint({
      ...occurrence,
      changes: {
        labels: { current: [{ color: "#fff", title: "ready" }], previous: [] },
        title: { current: "After", previous: "Before" },
      },
    });

    expect(first).toBe(second);
  });

  it("fails open when the payload has no reliable occurrence field", () => {
    expect(
      buildGitlabCrossHookFingerprint({
        ...occurrence,
        updatedAt: null,
        oldrev: null,
        changes: null,
      }),
    ).toBeNull();
    expect(
      buildGitlabCrossHookFingerprint({
        ...occurrence,
        updatedAt: null,
        oldrev: null,
        changes: {},
      }),
    ).toBeNull();
  });

  it("suppresses only the opposite source inside the 60-second window", () => {
    const fingerprint = buildGitlabCrossHookFingerprint({ ...occurrence, changes: null });
    expect(fingerprint).not.toBeNull();
    if (!fingerprint) return;

    rememberSuccessfulGitlabHookEvent({ fingerprint, hookSource: "system", processedAt: 1_000 });

    expect(isGitlabCrossHookDuplicate({ fingerprint, hookSource: "system", now: 2_000 })).toBe(false);
    expect(isGitlabCrossHookDuplicate({ fingerprint, hookSource: "project", now: 2_000 })).toBe(true);
    expect(
      isGitlabCrossHookDuplicate({
        fingerprint,
        hookSource: "project",
        now: 1_000 + GITLAB_CROSS_HOOK_DEDUP_TTL_MS + 1,
      }),
    ).toBe(false);
  });

  it("serializes same-connection work through the post-processing boundary", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withGitlabCrossHookDedupFence("connection-1", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = withGitlabCrossHookDedupFence("connection-1", async () => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });
});
