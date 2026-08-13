import type { FeishuBotBinding } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { shouldEnterOnboarding } from "../../onboarding/steps.js";
import { feishuStepCopy } from "../copy.js";
import {
  classifyOpenTagAgent,
  isFeishuHandoffUsable,
  type OpenTagAgentRead,
  type OpenTagToolsPrep,
  resolveOpenTagFeishuStep,
  resolveOpenTagStep,
} from "../flow.js";

const ORG = "org-1";

type ReadAgent = NonNullable<OpenTagAgentRead["agent"]>;

const MEMBER = "member-1";
// An Agent that reached the URL was created atomically with its Computer, so
// the usable shape is always a bound one.
const AGENT: ReadAgent = {
  organizationId: ORG,
  type: "agent",
  status: "active",
  clientId: "client-1",
  managerId: MEMBER,
  visibility: "organization",
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

describe("classifyOpenTagAgent", () => {
  it("reports no Agent when the URL carries none", () => {
    expect(classifyOpenTagAgent(read({ agentUuid: null, agent: null }))).toEqual({ state: "none" });
  });

  it("refuses every Team-scoped judgement until `/me` is authoritative", () => {
    // `meLoaded` also flips after a `/me` transport failure, so a guessed Team
    // must not unlock creation or Agent classification.
    expect(classifyOpenTagAgent(read({ meAuthoritative: false }))).toEqual({ state: "team-unreadable" });
    expect(classifyOpenTagAgent(read({ organizationId: null }))).toEqual({ state: "team-unreadable" });
    expect(classifyOpenTagAgent(read({ agentUuid: null, agent: null, meAuthoritative: false }))).toEqual({
      state: "team-unreadable",
    });
  });

  it("stays loading while the authoritative read is in flight", () => {
    expect(classifyOpenTagAgent(read({ loading: true, agent: null }))).toEqual({ state: "loading" });
  });

  it("resolves an Agent that is set up", () => {
    expect(classifyOpenTagAgent(read())).toEqual({ state: "resolved" });
  });

  it("treats an unbound Agent as unavailable", () => {
    // This flow only produces Agents that were created together with their
    // Computer, so an unbound one is a foreign object it cannot finish.
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, clientId: null } }))).toEqual({ state: "unavailable" });
  });

  it("treats a missing or forbidden Agent as unavailable", () => {
    expect(classifyOpenTagAgent(read({ agent: null, failed: true, errorStatus: 404 }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: null, failed: true, errorStatus: 403 }))).toEqual({
      state: "unavailable",
    });
  });

  it("treats an Agent from another Team, a human mirror, or a retired Agent as unavailable", () => {
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, organizationId: "org-2" } }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, type: "human" } }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, status: "deleted" } }))).toEqual({
      state: "unavailable",
    });
    // Suspended too: the first bind refuses it and a bound one cannot work.
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, status: "suspended" } }))).toEqual({
      state: "unavailable",
    });
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, status: "suspended" } }))).toEqual({
      state: "unavailable",
    });
  });

  it("treats a teammate's Agent as unavailable even though this member can read it", () => {
    // An organization-visible Agent owned by someone else passes the read, but
    // every write this flow makes needs manage authority — continuing on it
    // would only produce a wall of rejections.
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, managerId: "member-2" } }))).toEqual({
      state: "unavailable",
    });
    // An admin manages every Agent in their Team, so the same row is usable.
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, managerId: "member-2" }, role: "admin" }))).toEqual({
      state: "resolved",
    });
  });

  it("treats a private Agent as unavailable rather than walking it into a rejected Feishu write", () => {
    // `startRegistration` refuses every non-organization-visible Agent, so
    // binding a Computer first would only make the wall arrive later.
    expect(classifyOpenTagAgent(read({ agent: { ...AGENT, visibility: "private" } }))).toEqual({
      state: "unavailable",
    });
  });

  it("prefers a definitive failure over a cached copy of the Agent", () => {
    // The client already read this Agent, so it keeps serving the old row
    // after a delete. Continuing on it would offer setup for an Agent that
    // no longer exists.
    expect(classifyOpenTagAgent(read({ failed: true, errorStatus: 404 }))).toEqual({ state: "unavailable" });
  });

  it("keeps working from a cached Agent when the failure says nothing about it", () => {
    expect(classifyOpenTagAgent(read({ failed: true, errorStatus: 500 }))).toEqual({ state: "resolved" });
  });

  it("keeps a transient read failure retryable instead of discarding the Agent", () => {
    // A 500 is not evidence that the Agent is wrong. Dropping the URL Agent
    // here would silently restart the flow and create a second Agent.
    expect(classifyOpenTagAgent(read({ agent: null, failed: true, errorStatus: 500 }))).toEqual({
      state: "unreadable",
    });
  });

  it("keeps a transport failure retryable even though it carries no HTTP status", () => {
    // Offline / DNS / CORS produce a plain Error, not an ApiError. Treating a
    // missing status as "still loading" would leave a permanently blank page.
    expect(classifyOpenTagAgent(read({ agent: null, failed: true, errorStatus: null }))).toEqual({
      state: "unreadable",
    });
  });
});

describe("resolveOpenTagStep", () => {
  const notUsedYet = { state: "absent" } as const;

  it("starts at the Agent choice with no Agent, and recovers there from a wrong Agent", () => {
    expect(resolveOpenTagStep({ state: "none" }, notUsedYet)).toBe("choose-agent");
    expect(resolveOpenTagStep({ state: "unavailable" }, notUsedYet)).toBe("choose-agent");
  });

  it("holds the step until the authoritative read settles", () => {
    expect(resolveOpenTagStep({ state: "loading" }, notUsedYet)).toBeNull();
    expect(resolveOpenTagStep({ state: "unreadable" }, notUsedYet)).toBeNull();
    expect(resolveOpenTagStep({ state: "team-unreadable" }, notUsedYet)).toBeNull();
  });

  it("sends an existing Agent straight to Feishu", () => {
    // Both setup choices already happened at creation, so there is nothing
    // between an existing Agent and its Bot.
    expect(resolveOpenTagStep({ state: "resolved" }, notUsedYet)).toBe("connect-feishu");
  });

  it("only ends the journey once the Agent has a real Feishu Task", () => {
    expect(resolveOpenTagStep({ state: "resolved" }, { state: "present", chatId: "chat-1" })).toBe("use-in-feishu");
  });

  it("keeps the member on the Bot step while first use is unknown", () => {
    // A read that has not landed, or one that failed, is not evidence that
    // nothing happened — but it is certainly not evidence that it did, and
    // this is the branch that decides whether onboarding gets completed.
    expect(resolveOpenTagStep({ state: "resolved" }, { state: "unknown" })).toBe("connect-feishu");
  });

  it("cannot end the journey for an Agent that is not usable here", () => {
    // Defence in depth against a first-use answer outliving the Agent it was
    // read for: a deleted or foreign Agent restarts, whatever was cached.
    expect(resolveOpenTagStep({ state: "unavailable" }, { state: "present", chatId: "chat-1" })).toBe("choose-agent");
    expect(resolveOpenTagStep({ state: "unreadable" }, { state: "present", chatId: "chat-1" })).toBeNull();
  });
});

describe("why the readiness refresh has to be authoritative", () => {
  it("shows what a stale readiness fact would do to a member who already has an Agent", () => {
    // This is the gate OpenTag hands the member to. If `/me` was not refreshed
    // after the atomic create, the workspace root still sees no personal Agent
    // and sends them into onboarding — whose create step only skips itself when
    // this same fact is true. That is the second-Agent path the strict refresh
    // exists to close, so it is asserted here rather than described in prose.
    const stale = {
      meLoaded: true,
      onboardingStep: "completed" as const,
      currentOrgHasPersonalAgent: false,
      onboardingSuppressedAt: null,
      onboardingCompletedAt: null,
    };
    expect(shouldEnterOnboarding(stale)).toBe(true);
    expect(shouldEnterOnboarding({ ...stale, currentOrgHasPersonalAgent: true })).toBe(false);
  });
});

describe("what the Feishu step is showing and what it offers", () => {
  const BINDING: FeishuBotBinding = {
    id: "binding-1",
    agentId: "agent-1",
    appId: "cli_1",
    botOpenId: null,
    botName: null,
    botAvatarUrl: null,
    tenantKey: null,
    status: "active",
    connectionStatus: "connected",
    grantedScopes: [],
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "missing", version: null, clientId: "client-1" },
  };
  const READY_CLI = { state: "ready" as const, version: "1.4.0", clientId: "client-1" };
  const waiting = { binding: BINDING, callFailed: false, slow: false };

  it("prepares nothing for a member who has not chosen Feishu", () => {
    // No Bot means no commitment, and a machine check nobody asked for is
    // exactly the install concept this flow exists to keep off the member.
    expect(resolveOpenTagFeishuStep({ binding: null, callFailed: false, slow: false })).toEqual({
      tools: { state: "idle" },
      recovery: "none",
      canRetryTools: false,
    });
  });

  it("asks nothing of the member while the wait is ordinary", () => {
    expect(resolveOpenTagFeishuStep(waiting)).toEqual({
      tools: { state: "preparing" },
      recovery: "none",
      canRetryTools: false,
    });
  });

  it("offers a way forward once waiting has stopped being reasonable", () => {
    expect(resolveOpenTagFeishuStep({ ...waiting, slow: true })).toEqual({
      tools: { state: "recoverable", reason: "slow" },
      recovery: "offered",
      canRetryTools: true,
    });
    expect(resolveOpenTagFeishuStep({ ...waiting, callFailed: true })).toEqual({
      tools: { state: "recoverable", reason: "failed" },
      recovery: "offered",
      canRetryTools: true,
    });
  });

  it("says the request failed rather than that it is taking a while", () => {
    // A request that never landed is established, not suspected: the member is
    // not waiting for anything, and a timeout that measures nothing would tell
    // them to keep waiting for work that was never started.
    expect(resolveOpenTagFeishuStep({ ...waiting, callFailed: true, slow: true }).tools).toEqual({
      state: "recoverable",
      reason: "failed",
    });
  });

  it("reports the capability, not the history that produced it", () => {
    // The Agent may well have failed once and recovered on its own. What the
    // member needs is whether their Agent can work in Feishu now.
    const binding = { ...BINDING, cli: READY_CLI };
    expect(resolveOpenTagFeishuStep({ binding, callFailed: true, slow: true }).tools).toEqual({ state: "ready" });
  });

  it("strands nobody when the Bot is the half that never lands", () => {
    // A Computer that was ready all along sends no request, so timing the
    // request would leave exactly this member with no way out: the Bot is stuck,
    // and the page offers nothing. Retrying is not among the ways forward —
    // the automatic preparation has nothing left to do.
    const stuck = { ...BINDING, status: "provisioning" as const, connectionStatus: "disconnected" as const };
    const state = resolveOpenTagFeishuStep({ binding: { ...stuck, cli: READY_CLI }, callFailed: false, slow: true });
    expect(state).toEqual({ tools: { state: "ready" }, recovery: "offered", canRetryTools: false });
  });

  it("offers nothing once the handoff actually works", () => {
    // A long wait that ended well is not a problem to recover from — and
    // neither is one that started with a failed request and then converged.
    // The Agent may well have recovered on its own; offering a way out beside
    // an invitation to go and use the Bot would contradict it.
    const usable = { ...BINDING, cli: READY_CLI };
    expect(resolveOpenTagFeishuStep({ binding: usable, callFailed: false, slow: true }).recovery).toBe("none");
    expect(resolveOpenTagFeishuStep({ binding: usable, callFailed: true, slow: false }).recovery).toBe("none");
    expect(resolveOpenTagFeishuStep({ binding: usable, callFailed: true, slow: true }).recovery).toBe("none");
  });
});

describe("when the Feishu handoff is genuinely usable", () => {
  const usable: FeishuBotBinding = {
    id: "binding-1",
    agentId: "agent-1",
    appId: "cli_1",
    botOpenId: null,
    botName: null,
    botAvatarUrl: null,
    tenantKey: null,
    status: "active",
    connectionStatus: "connected",
    grantedScopes: [],
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "ready", version: "1.4.0", clientId: "client-1" },
  };

  it("needs both halves at once", () => {
    expect(isFeishuHandoffUsable(usable)).toBe(true);
    expect(isFeishuHandoffUsable(null)).toBe(false);
  });

  it("refuses a reachable Bot the Agent could not answer", () => {
    // Messages would arrive and go unanswered, and the Task they create would
    // otherwise finish onboarding on a handoff that does not work.
    expect(isFeishuHandoffUsable({ ...usable, cli: { state: "missing", version: null, clientId: "client-1" } })).toBe(
      false,
    );
    expect(isFeishuHandoffUsable({ ...usable, cli: { state: "unknown", version: null, clientId: "client-1" } })).toBe(
      false,
    );
  });

  it("refuses a ready Computer with no reachable Bot", () => {
    expect(isFeishuHandoffUsable({ ...usable, connectionStatus: "connecting" })).toBe(false);
    expect(isFeishuHandoffUsable({ ...usable, status: "provisioning" })).toBe(false);
  });
});

describe("what the Feishu step says about itself", () => {
  const TOOLS: OpenTagToolsPrep[] = [
    { state: "idle" },
    { state: "preparing" },
    { state: "ready" },
    { state: "unavailable" },
    { state: "recoverable", reason: "slow" },
    { state: "recoverable", reason: "failed" },
  ];

  /** Language that promises work is under way on the Agent's Computer. */
  const CLAIMS_WORK_UNDERWAY = [
    "still preparing",
    "keep checking this Computer",
    "Finishing Agent tools",
    "Preparing this Computer",
  ];

  it("never claims the Computer is busy when it is done, missing, or was never asked", () => {
    // Three surfaces report the same two facts — the page heading, the panel
    // header, and the rows. Deriving them separately is exactly how they came
    // to contradict each other, so this pins every combination at once.
    for (const tools of TOOLS) {
      if (tools.state === "preparing" || (tools.state === "recoverable" && tools.reason === "slow")) continue;
      for (const botReachable of [true, false]) {
        const { heading, panel } = feishuStepCopy(botReachable, tools);
        const said = `${heading?.why ?? ""} ${heading?.lead ?? ""} ${panel?.title ?? ""} ${panel?.lead ?? ""}`;
        for (const claim of CLAIMS_WORK_UNDERWAY) {
          expect(`${tools.state}/${botReachable}: ${said}`).not.toContain(claim);
        }
      }
    }
  });

  it("says nothing at all once both halves are done", () => {
    const done = feishuStepCopy(true, { state: "ready" });
    expect(done.heading).toBeNull();
    expect(done.panel).toBeNull();
  });

  it("keeps the standing heading while waiting is still ordinary", () => {
    expect(feishuStepCopy(true, { state: "preparing" }).heading).toBeNull();
    expect(feishuStepCopy(false, { state: "preparing" }).heading).toBeNull();
  });

  it("reports a request that never landed as failed, not as slow", () => {
    const { heading, panel } = feishuStepCopy(true, { state: "recoverable", reason: "failed" });
    expect(heading?.why).toContain("couldn't start");
    expect(panel?.title).toContain("didn't start");
  });

  it("names the missing Computer rather than describing preparation", () => {
    const { heading, panel } = feishuStepCopy(true, { state: "unavailable" });
    expect(heading?.why).toContain("no Computer");
    expect(panel?.title).toContain("can't be prepared");
  });

  it("keeps the approved copy for the state the contract pictures", () => {
    const { heading, panel } = feishuStepCopy(true, { state: "recoverable", reason: "slow" });
    expect(heading?.why).toBe("One last part is taking longer.");
    expect(heading?.lead).toBe(
      "Your Feishu Bot is connected. Your Agent's Computer is still preparing the tools it needs to reply.",
    );
    expect(panel?.title).toBe("Finishing Agent tools…");
  });
});

describe("an Agent with no Computer to prepare", () => {
  const OFFLINE: FeishuBotBinding = {
    id: "binding-1",
    agentId: "agent-1",
    appId: "cli_1",
    botOpenId: null,
    botName: null,
    botAvatarUrl: null,
    tenantKey: null,
    status: "active",
    connectionStatus: "connected",
    grantedScopes: [],
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "offline", version: null, clientId: null },
  };

  it("does not wait out a clock for something that cannot start", () => {
    // No Computer is established, like a failed request — not suspected, like a
    // slow one. Sitting on the 90-second timer would leave the member watching
    // preparation that can never begin.
    const state = resolveOpenTagFeishuStep({ binding: OFFLINE, callFailed: false, slow: false });
    expect(state.tools).toEqual({ state: "unavailable" });
    expect(state.recovery).toBe("offered");
  });

  it("does not offer to retry what has nowhere to run", () => {
    const state = resolveOpenTagFeishuStep({ binding: OFFLINE, callFailed: false, slow: true });
    expect(state.canRetryTools).toBe(false);
  });
});
