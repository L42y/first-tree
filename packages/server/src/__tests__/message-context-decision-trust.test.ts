import { CONTEXT_DECISION_METADATA_KEY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { preflightMessageSendIntent, type SendIntentParticipant } from "../services/message.js";

const HUMAN: SendIntentParticipant = {
  agentId: "human-1",
  name: "gandy",
  displayName: "Gandy",
  status: "active",
  type: "human",
};
const AGENT: SendIntentParticipant = {
  agentId: "agent-1",
  name: "assistant",
  displayName: "Assistant",
  status: "active",
  type: "agent",
};

const RECEIPT = {
  version: 1,
  effect: "constrained",
  summary: "The organization-isolation constraint ruled out a global shared index.",
  evidence: [
    {
      repoUrl: "https://github.com/example/context-tree",
      commit: "0123456789abcdef0123456789abcdef01234567",
      nodePath: "system/cloud/team/tenancy-and-identity.md",
      heading: "Organization isolation",
    },
  ],
};

function preflight(sender: SendIntentParticipant, receipt: unknown) {
  return preflightMessageSendIntent({
    chatId: "chat-1",
    senderId: sender.agentId,
    senderType: sender.type,
    data: {
      format: "markdown",
      content: "Keeping the index per organization.",
      source: "cli",
      metadata: {
        [CONTEXT_DECISION_METADATA_KEY]: receipt,
        mentions: [sender.agentId === HUMAN.agentId ? AGENT.agentId : HUMAN.agentId],
      },
    },
    participants: [HUMAN, AGENT],
  });
}

describe("contextDecision receipt trust boundary", () => {
  it("keeps a well-formed receipt from an agent sender", () => {
    expect(preflight(AGENT, RECEIPT).metadata[CONTEXT_DECISION_METADATA_KEY]).toEqual(RECEIPT);
  });

  it("strips the receipt from a human sender so it cannot be spoofed", () => {
    expect(preflight(HUMAN, RECEIPT).metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });

  it("rejects a malformed receipt from an agent sender instead of storing it", () => {
    expect(() => preflight(AGENT, { ...RECEIPT, effect: "none" })).toThrow(/metadata.contextDecision/);
    expect(() => preflight(AGENT, { ...RECEIPT, evidence: [] })).toThrow(/metadata.contextDecision/);
    expect(() => preflight(AGENT, "constrained")).toThrow(/metadata.contextDecision/);
  });

  it("leaves an ordinary send untouched", () => {
    const result = preflightMessageSendIntent({
      chatId: "chat-1",
      senderId: AGENT.agentId,
      senderType: AGENT.type,
      data: { format: "text", content: "No receipt here.", source: "cli", metadata: { mentions: [HUMAN.agentId] } },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });
});
