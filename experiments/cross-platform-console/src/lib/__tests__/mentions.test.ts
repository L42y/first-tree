import type { ChatParticipantDetail } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  buildMentionCandidates,
  buildMentionInsert,
  computeRequiresMention,
  findActiveMentionTrigger,
  findSolePeerAgentId,
  isSelfOnlySpeakerRoster,
  rankMentionCandidates,
} from "../mentions";

const participant = (agentId: string, name: string, displayName = name): ChatParticipantDetail => ({
  agentId,
  role: "member",
  mode: "speaker",
  joinedAt: "2026-01-01T00:00:00.000Z",
  name,
  displayName,
  type: "agent",
  avatarColorToken: null,
  avatarImageUrl: null,
});

const roster = [
  participant("self", "self-agent", "Me"),
  participant("peer", "peer-agent", "Peer"),
  participant("other", "other-agent", "Other"),
];

describe("expo mention addressing", () => {
  it("matches the web speaker-shape rule", () => {
    expect(computeRequiresMention(["self", "peer"], "self")).toBe(false);
    expect(computeRequiresMention(["peer"], "self")).toBe(false);
    expect(computeRequiresMention(["peer", "watcher-peer"], "self")).toBe(true);
    expect(computeRequiresMention(["self", "peer", "other"], "self")).toBe(true);
  });

  it("recognizes self-only rosters and the sole peer", () => {
    expect(isSelfOnlySpeakerRoster(["self"], "self")).toBe(true);
    expect(findSolePeerAgentId(roster, "self")).toBeNull();
    expect(findSolePeerAgentId(roster.slice(0, 2), "self")).toBe("peer");
  });

  it("excludes self and uses canonical names for routing", () => {
    const candidates = buildMentionCandidates(roster, "self");
    expect(candidates.map((candidate) => candidate.agentId)).toEqual(["other", "peer"]);
  });

  it("finds an unfinished token only at a mention boundary", () => {
    expect(findActiveMentionTrigger("hi @pe", 6)).toEqual({ triggerIndex: 3, query: "pe" });
    expect(findActiveMentionTrigger("hi @", 4)).toEqual({ triggerIndex: 3, query: "" });
    expect(findActiveMentionTrigger("contact@pe", 10)).toBeNull();
  });

  it("ranks prefixes and supports substring fallback", () => {
    const candidates = [
      { agentId: "3", name: "deploy-helper", displayName: "Deploy Helper" },
      { agentId: "1", name: "deploy", displayName: "Deployment" },
      { agentId: "2", name: "ci", displayName: "Deploy Checks" },
    ];
    expect(rankMentionCandidates(candidates, "deploy").map((candidate) => candidate.agentId)).toEqual(["3", "1", "2"]);
    expect(rankMentionCandidates(candidates, "y-helper").map((candidate) => candidate.agentId)).toEqual(["3"]);
  });

  it("replaces the active query and leaves one word boundary", () => {
    const trigger = findActiveMentionTrigger("ask @pe about it", 7);
    const candidate = { agentId: "peer", name: "peer-agent", displayName: "Peer" };
    if (!trigger) throw new Error("Expected an active mention trigger");
    expect(trigger).toEqual({ triggerIndex: 4, query: "pe" });
    expect(buildMentionInsert("ask @pe about it", trigger, candidate)).toEqual({
      text: "ask @peer-agent about it",
      cursor: 15,
    });
  });
});
