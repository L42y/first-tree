import { describe, expect, it, vi } from "vitest";
import {
  normalizeContextReviewConfig,
  readContextReviewConfig,
  readMemberContextReviewConfig,
} from "../core/context-review-config.js";

const liveReviewer = (agentUuid: string) => ({
  enabled: true,
  agentUuid,
  managerHumanAgentId: "human-admin-1",
  managerActiveAdmin: true,
});

describe("Context Review config", () => {
  it("normalizes one live binding and assignment tuple", () => {
    expect(
      normalizeContextReviewConfig(
        {
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: liveReviewer("reviewer-1"),
        },
        "reviewer-1",
      ),
    ).toEqual({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      providerMatchesRepository: true,
      gitlabConnection: null,
      enabled: true,
      assigned: true,
      agentUuid: "reviewer-1",
      managerHumanAgentId: "human-admin-1",
      managerActiveAdmin: true,
    });
  });

  it("does not assign a disabled or different Reviewer", () => {
    expect(
      normalizeContextReviewConfig(
        {
          repo: null,
          branch: null,
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: {
            enabled: false,
            agentUuid: null,
            managerHumanAgentId: null,
            managerActiveAdmin: false,
          },
        },
        "reviewer-1",
      ).assigned,
    ).toBe(false);
    expect(
      normalizeContextReviewConfig(
        {
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: liveReviewer("reviewer-2"),
        },
        "reviewer-1",
      ).assigned,
    ).toBe(false);
  });

  it("keeps ordinary assignment but exposes a blocked SCOPE approver after demotion", () => {
    const demoted = normalizeContextReviewConfig(
      {
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
        providerMatchesRepository: true,
        gitlabConnection: null,
        contextReviewer: {
          enabled: true,
          agentUuid: "reviewer-1",
          managerHumanAgentId: "human-admin-1",
          managerActiveAdmin: false,
        },
      },
      "reviewer-1",
    );
    expect(demoted.assigned).toBe(true);
    expect(demoted.managerActiveAdmin).toBe(false);
    expect(demoted.managerHumanAgentId).toBe("human-admin-1");
  });

  it("fails closed for an invalid mixed response", () => {
    expect(() =>
      normalizeContextReviewConfig(
        {
          repo: "https://github.com/acme/context-tree.git",
          branch: 42,
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: { enabled: true },
        },
        "reviewer-1",
      ),
    ).toThrow(SyntaxError);
  });

  it("reads exactly one SDK response", async () => {
    const getAgentContextReviewConfig = vi.fn(async () => ({
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      providerMatchesRepository: true,
      gitlabConnection: null,
      contextReviewer: liveReviewer("reviewer-1"),
    }));
    await expect(
      readContextReviewConfig({ agentId: "reviewer-1", getAgentContextReviewConfig }),
    ).resolves.toMatchObject({ assigned: true });
    expect(getAgentContextReviewConfig).toHaveBeenCalledTimes(1);
  });

  it("combines the two existing member-readable settings without requiring a local Agent", async () => {
    const getMemberContextTreeSetting = vi.fn(async () => ({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    }));
    const getMemberContextTreeFeatures = vi.fn(async () => ({
      contextReviewer: {
        enabled: true,
        agentUuid: "reviewer-private",
        reviewerAgent: {
          uuid: "reviewer-private",
          name: "reviewer",
          displayName: "Reviewer",
          managerHumanAgentId: "human-admin-1",
          managerActiveAdmin: true,
        },
      },
    }));

    await expect(
      readMemberContextReviewConfig({ getMemberContextTreeSetting, getMemberContextTreeFeatures }, "org-1"),
    ).resolves.toEqual({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      providerMatchesRepository: true,
      gitlabConnection: null,
      enabled: true,
      assigned: true,
      agentUuid: "reviewer-private",
      managerHumanAgentId: "human-admin-1",
      managerActiveAdmin: true,
    });
    expect(getMemberContextTreeSetting).toHaveBeenCalledWith("org-1");
    expect(getMemberContextTreeFeatures).toHaveBeenCalledWith("org-1");
  });

  it("preserves the exact live GitLab connection authority", () => {
    expect(
      normalizeContextReviewConfig(
        {
          provider: "gitlab",
          repo: "git@gitlab.internal:group/context-tree.git",
          branch: "main",
          providerMatchesRepository: true,
          gitlabConnection: { id: "connection-1", instanceOrigin: "https://gitlab.internal:8443" },
          contextReviewer: liveReviewer("reviewer-1"),
        },
        "reviewer-1",
      ),
    ).toMatchObject({
      provider: "gitlab",
      providerMatchesRepository: true,
      gitlabConnection: { id: "connection-1", instanceOrigin: "https://gitlab.internal:8443" },
      assigned: true,
    });
  });

  it("rejects a non-normalized GitLab authority projection", () => {
    expect(() =>
      normalizeContextReviewConfig(
        {
          provider: "gitlab",
          repo: "git@gitlab.internal:group/context-tree.git",
          branch: "main",
          providerMatchesRepository: true,
          gitlabConnection: { id: "connection-1", instanceOrigin: "https://GITLAB.internal/" },
          contextReviewer: liveReviewer("reviewer-1"),
        },
        "reviewer-1",
      ),
    ).toThrow(SyntaxError);
  });

  it("fails closed when a matching GitLab binding omits its live connection", () => {
    expect(() =>
      normalizeContextReviewConfig(
        {
          provider: "gitlab",
          repo: "git@gitlab.internal:group/context-tree.git",
          branch: "main",
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: liveReviewer("reviewer-1"),
        },
        "reviewer-1",
      ),
    ).toThrow(SyntaxError);
  });
});
