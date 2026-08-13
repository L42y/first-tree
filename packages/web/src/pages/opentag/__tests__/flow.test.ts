import { describe, expect, it } from "vitest";
import { classifyOpenTagAgent, type OpenTagAgentRead, resolveOpenTagStep } from "../flow.js";

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
  it("starts at the Agent choice with no Agent, and recovers there from a wrong Agent", () => {
    expect(resolveOpenTagStep({ state: "none" })).toBe("choose-agent");
    expect(resolveOpenTagStep({ state: "unavailable" })).toBe("choose-agent");
  });

  it("holds the step until the authoritative read settles", () => {
    expect(resolveOpenTagStep({ state: "loading" })).toBeNull();
    expect(resolveOpenTagStep({ state: "unreadable" })).toBeNull();
    expect(resolveOpenTagStep({ state: "team-unreadable" })).toBeNull();
  });

  it("sends an existing Agent straight to Feishu", () => {
    // Both setup choices already happened at creation, so there is nothing
    // between an existing Agent and its Bot.
    expect(resolveOpenTagStep({ state: "resolved" })).toBe("connect-feishu");
  });
});
