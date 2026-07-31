import { type AgentChatStatusInput, buildAgentChatStatus } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { canPauseStatus, canResetSessionStatus, canResumeStatus } from "../agent-status-panel.js";

const base: AgentChatStatusInput = {
  agentId: "a",
  reachable: true,
  errored: false,
  working: false,
  engagement: "none",
};
const mk = (over: Partial<AgentChatStatusInput>) => buildAgentChatStatus({ ...base, ...over });

describe("canPauseStatus — Pause only for an actively-working live session", () => {
  it("working + active session → true", () => {
    expect(canPauseStatus(mk({ working: true, engagement: "active" }))).toBe(true);
  });

  it("active session but NOT working (main=ready) → false", () => {
    // The codex blocker: an active-but-idle session must not surface Pause.
    expect(canPauseStatus(mk({ engagement: "active" }))).toBe(false);
  });

  it("working but already suspended → false (server would 409)", () => {
    expect(canPauseStatus(mk({ working: true, engagement: "suspended" }))).toBe(false);
  });

  it("offline (unreachable) → false even with an active session", () => {
    expect(canPauseStatus(mk({ reachable: false, working: true, engagement: "active" }))).toBe(false);
  });

  it("null status → false", () => {
    expect(canPauseStatus(null)).toBe(false);
  });
});

describe("canResumeStatus — Resume only for suspended sessions", () => {
  it("suspended session → true", () => {
    expect(canResumeStatus(mk({ engagement: "suspended" }))).toBe(true);
  });

  it("active session → false", () => {
    expect(canResumeStatus(mk({ engagement: "active" }))).toBe(false);
  });

  it("null status → false", () => {
    expect(canResumeStatus(null)).toBe(false);
  });
});

describe("canResetSessionStatus — Reset only for a stopped session on a capable online client", () => {
  it("suspended session with apply-ack support → true", () => {
    expect(canResetSessionStatus(mk({ engagement: "suspended", sessionResetSupported: true }))).toBe(true);
  });

  it("errored session (engagement none + errored axis) with apply-ack support → true", () => {
    expect(canResetSessionStatus(mk({ engagement: "none", errored: true, sessionResetSupported: true }))).toBe(true);
  });

  it("active session → false, working or idle (pause first)", () => {
    expect(canResetSessionStatus(mk({ engagement: "active", sessionResetSupported: true }))).toBe(false);
    expect(canResetSessionStatus(mk({ engagement: "active", working: true, sessionResetSupported: true }))).toBe(false);
  });

  it("no session (engagement none, not errored) → false", () => {
    expect(canResetSessionStatus(mk({ engagement: "none", sessionResetSupported: true }))).toBe(false);
  });

  it("offline (unreachable) → false even for a stopped session", () => {
    expect(canResetSessionStatus(mk({ reachable: false, engagement: "suspended", sessionResetSupported: true }))).toBe(
      false,
    );
  });

  it("without the apply-ack capability (old client) → false", () => {
    expect(canResetSessionStatus(mk({ engagement: "suspended" }))).toBe(false);
    expect(canResetSessionStatus(mk({ engagement: "suspended", sessionResetSupported: false }))).toBe(false);
  });

  it("null status → false", () => {
    expect(canResetSessionStatus(null)).toBe(false);
  });
});
