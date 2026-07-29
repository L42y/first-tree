import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeContextTree: vi.fn(),
  getContextTreeSetting: vi.fn(),
  confirmTeamRepositoriesForOrg: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));
vi.mock("../../../api/context-tree.js", () => ({ initializeContextTree: mocks.initializeContextTree }));
vi.mock("../../../api/org-settings.js", () => ({ getContextTreeSetting: mocks.getContextTreeSetting }));
vi.mock("../../../api/resources.js", () => ({
  confirmTeamRepositoriesForOrg: mocks.confirmTeamRepositoriesForOrg,
  listTeamResourcesForOrg: mocks.listTeamResourcesForOrg,
}));

import { ApiError } from "../../../api/client.js";
import { ensureSourceReposRegistered, provisionNewTree, repoLabel, startChatErrorMessage } from "../provision-tree.js";

const CREATED = {
  repo: "https://github.com/acme/acme-context-tree",
  htmlUrl: "https://github.com/acme/acme-context-tree",
  branch: "main",
  nodePath: "NODE.md",
};

const recommendedRepo = (url: string, key: string) => ({
  type: "repo",
  status: "active",
  defaultEnabled: "recommended",
  repoCanonicalKey: key,
  payload: { url },
});

beforeEach(() => {
  mocks.initializeContextTree.mockReset();
  mocks.getContextTreeSetting.mockReset();
  mocks.confirmTeamRepositoriesForOrg.mockReset();
  mocks.listTeamResourcesForOrg.mockReset();
});

describe("provisionNewTree", () => {
  it("initializes and does not probe binding state on success", async () => {
    mocks.initializeContextTree.mockResolvedValue(CREATED);
    await provisionNewTree("org-1");
    expect(mocks.initializeContextTree).toHaveBeenCalledWith("org-1");
    expect(mocks.getContextTreeSetting).not.toHaveBeenCalled();
  });

  it("treats a 409 as success when a tree binding now exists (detect→create race / retry)", async () => {
    mocks.initializeContextTree.mockRejectedValue(
      new ApiError(409, "Context Tree repo is already configured for this team"),
    );
    mocks.getContextTreeSetting.mockResolvedValue({
      repo: "https://github.com/acme/acme-context-tree",
      branch: "main",
    });
    await expect(provisionNewTree("org-1")).resolves.toBeUndefined();
  });

  it("re-throws a 409 when no tree was created (e.g. repo access required)", async () => {
    mocks.initializeContextTree.mockRejectedValue(
      new ApiError(409, "repo access required", undefined, "context_tree_repo_access_required"),
    );
    mocks.getContextTreeSetting.mockResolvedValue({ repo: null, branch: null });
    await expect(provisionNewTree("org-1")).rejects.toBeInstanceOf(ApiError);
  });

  it("re-throws a non-409 error without probing binding state", async () => {
    mocks.initializeContextTree.mockRejectedValue(new ApiError(403, "installation permissions insufficient"));
    await expect(provisionNewTree("org-1")).rejects.toBeInstanceOf(ApiError);
    expect(mocks.getContextTreeSetting).not.toHaveBeenCalled();
  });
});

describe("ensureSourceReposRegistered", () => {
  it("is a no-op for an empty repo list", async () => {
    await ensureSourceReposRegistered("org-1", []);
    expect(mocks.confirmTeamRepositoriesForOrg).not.toHaveBeenCalled();
    expect(mocks.listTeamResourcesForOrg).not.toHaveBeenCalled();
  });

  it("confirms the exact source set in one optimistic batch", async () => {
    mocks.listTeamResourcesForOrg.mockResolvedValue([]);
    mocks.confirmTeamRepositoriesForOrg.mockResolvedValue({
      repositories: [
        recommendedRepo("https://github.com/acme/app", "github.com/acme/app"),
        recommendedRepo("https://github.com/acme/api", "github.com/acme/api"),
      ],
    });
    await ensureSourceReposRegistered("org-1", ["https://github.com/acme/app", "https://github.com/acme/api"]);
    expect(mocks.confirmTeamRepositoriesForOrg).toHaveBeenCalledWith("org-1", {
      expectedActiveRepositoryKeys: [],
      repositories: [
        { name: "acme/app", url: "https://github.com/acme/app" },
        { name: "acme/api", url: "https://github.com/acme/api" },
      ],
    });
  });

  it("passes the observed active set and throws when the batch response is incomplete", async () => {
    mocks.listTeamResourcesForOrg.mockResolvedValue([
      recommendedRepo("https://github.com/acme/existing", "github.com/acme/existing"),
    ]);
    mocks.confirmTeamRepositoriesForOrg.mockResolvedValue({
      repositories: [recommendedRepo("https://github.com/acme/app", "github.com/acme/app")],
    });
    await expect(
      ensureSourceReposRegistered("org-1", ["https://github.com/acme/app", "https://github.com/acme/api"]),
    ).rejects.toThrow(/acme\/api/);
    expect(mocks.confirmTeamRepositoriesForOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ expectedActiveRepositoryKeys: ["github.com/acme/existing"] }),
    );
  });
});

describe("repoLabel", () => {
  it("reduces a repo URL to its owner/name path", () => {
    expect(repoLabel("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repoLabel("git@github.com:acme/api.git")).toBe("acme/api");
  });
});

describe("startChatErrorMessage", () => {
  it("maps a known provisioning code to a plain message (not the raw server string)", () => {
    const msg = startChatErrorMessage(
      new ApiError(409, "GitHub repo octocat/team-context-tree exists", undefined, "context_tree_repo_access_required"),
      "fallback",
    );
    expect(msg).toMatch(/Grant the App access/i);
    expect(msg).not.toMatch(/octocat\/team-context-tree/);
    // repo_unavailable (repo create/access denied by the App installation) is mapped too.
    expect(
      startChatErrorMessage(new ApiError(409, "not accessible", undefined, "repo_unavailable"), "fallback"),
    ).toMatch(/couldn't create or access/);
    // A missing/expired GitHub user token maps to a "reconnect GitHub" message.
    expect(
      startChatErrorMessage(new ApiError(503, "token", undefined, "github_user_token_required"), "fallback"),
    ).toMatch(/Reconnect GitHub/);
  });
  it("falls back for an ApiError with an unknown / missing code (never leaks the server string)", () => {
    expect(startChatErrorMessage(new ApiError(500, "internal detail"), "fallback")).toBe("fallback");
    expect(startChatErrorMessage(new ApiError(409, "weird", undefined, "totally_unknown"), "fallback")).toBe(
      "fallback",
    );
  });
  it("surfaces a plain Error's message (our own friendly errors carry good copy)", () => {
    expect(startChatErrorMessage(new Error("Couldn't register 2 source repos"), "fallback")).toBe(
      "Couldn't register 2 source repos",
    );
  });
  it("uses the fallback for a non-Error throw", () => {
    expect(startChatErrorMessage("nope", "fallback")).toBe("fallback");
  });
});
