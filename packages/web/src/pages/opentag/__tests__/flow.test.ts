import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  classifyOpenTagAgent,
  deriveOpenTagRuntimeState,
  type OpenTagAgentRead,
  resolveOpenTagPageState,
  runtimeIsReady,
} from "../flow.js";

const ORG = "org-1";
const MEMBER = "member-1";
const AGENT = {
  organizationId: ORG,
  type: "agent" as const,
  status: "active",
  clientId: "client-1",
  managerId: MEMBER,
  visibility: "organization" as const,
};

function read(overrides: Partial<OpenTagAgentRead> = {}): OpenTagAgentRead {
  return {
    organizationId: ORG,
    meAuthoritative: true,
    memberId: MEMBER,
    role: "member",
    agentUuid: "0198b2c4-1f6a-7c31-9a02-4d5e6f708192",
    loading: false,
    failed: false,
    errorStatus: null,
    agent: AGENT,
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    detectedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyOpenTagAgent", () => {
  it("keeps creation closed until Team authority is established", () => {
    expect(classifyOpenTagAgent(read({ meAuthoritative: false }))).toEqual({ state: "team-unreadable" });
    expect(classifyOpenTagAgent(read({ organizationId: null }))).toEqual({ state: "team-unreadable" });
  });

  it("keeps transport failures retryable without discarding the URL Agent", () => {
    expect(classifyOpenTagAgent(read({ failed: true, agent: null }))).toEqual({ state: "unreadable" });
    expect(classifyOpenTagAgent(read({ failed: true, errorStatus: 500, agent: AGENT }))).toEqual({ state: "resolved" });
  });

  it("rejects missing, foreign, unbound, private, inactive, and unmanageable Agents", () => {
    expect(classifyOpenTagAgent(read({ failed: true, errorStatus: 404, agent: null }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, organizationId: "org-2" } }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, clientId: null } }))).toEqual({ state: "unavailable" });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, visibility: "private" } }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, status: "suspended" } }))).toEqual({ state: "unavailable" });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, managerId: "member-2" }, role: "member" }))).toEqual({
      state: "unavailable",
    });
  });

  it("allows a manager or Team admin to resume an organization-visible Agent", () => {
    expect(classifyOpenTagAgent(read())).toEqual({ state: "resolved" });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, managerId: "member-2" }, role: "admin" }))).toEqual({
      state: "resolved",
    });
  });
});

describe("OpenTag single-page conditions", () => {
  it("resolves all five approved visual states from live facts", () => {
    expect(
      resolveOpenTagPageState({ hasCreatedAgent: false, hasComputer: false, runtimeReady: false, handoffReady: false }),
    ).toBe("connect-computer");
    expect(
      resolveOpenTagPageState({ hasCreatedAgent: false, hasComputer: true, runtimeReady: false, handoffReady: false }),
    ).toBe("agent-blocked");
    expect(
      resolveOpenTagPageState({ hasCreatedAgent: false, hasComputer: true, runtimeReady: true, handoffReady: false }),
    ).toBe("create-agent");
    expect(
      resolveOpenTagPageState({ hasCreatedAgent: true, hasComputer: true, runtimeReady: true, handoffReady: false }),
    ).toBe("add-to-feishu");
    expect(
      resolveOpenTagPageState({ hasCreatedAgent: true, hasComputer: false, runtimeReady: false, handoffReady: true }),
    ).toBe("ready");
  });

  it("does not call an auth recovery pending or failed runtime ready", () => {
    expect(runtimeIsReady(capability())).toBe(true);
    expect(
      runtimeIsReady(capability({ pendingAuth: { method: "browser", expiresAt: "2099-01-01T00:00:00.000Z" } })),
    ).toBe(false);
    expect(runtimeIsReady(capability({ lastAuthError: { reason: "timeout", at: "2026-08-14T00:00:00.000Z" } }))).toBe(
      false,
    );
  });

  it("falls back from an expired pending auth snapshot", () => {
    const entry = capability({
      pendingAuth: { method: "browser", expiresAt: "2026-08-14T00:00:00.000Z" },
    });
    const nowMs = Date.parse("2026-08-14T00:00:01.000Z");

    expect(runtimeIsReady(entry, nowMs)).toBe(true);
    expect(deriveOpenTagRuntimeState({ capabilitiesLoaded: true, provider: "codex", entry, nowMs })).toEqual({
      kind: "ready",
      provider: "codex",
    });
  });

  it("derives checking, install, auth, and ready recovery variants", () => {
    expect(deriveOpenTagRuntimeState({ capabilitiesLoaded: false, provider: "codex", entry: null })).toEqual({
      kind: "checking",
    });
    expect(
      deriveOpenTagRuntimeState({
        capabilitiesLoaded: true,
        provider: "codex",
        entry: capability({ state: "missing", available: false }),
      }),
    ).toEqual({ kind: "install", provider: "codex" });
    expect(
      deriveOpenTagRuntimeState({
        capabilitiesLoaded: true,
        provider: "codex",
        entry: capability({ lastAuthError: { reason: "timeout", at: "2026-08-14T00:00:00.000Z" } }),
      }),
    ).toEqual({ kind: "sign-in", provider: "codex" });
    expect(deriveOpenTagRuntimeState({ capabilitiesLoaded: true, provider: "codex", entry: capability() })).toEqual({
      kind: "ready",
      provider: "codex",
    });
  });
});
