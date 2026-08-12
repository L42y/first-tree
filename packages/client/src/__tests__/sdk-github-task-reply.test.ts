import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, type SdkError } from "../cloud/sdk.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("FirstTreeHubSDK.submitGithubTaskReply", () => {
  it("sends exact Agent and runtime-session proof to the recipient-bound run endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          commentId: 42,
          commentUrl: "https://github.com/o/r/issues/7#issuecomment-42",
          appActor: "first-tree[bot]",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://cloud.example",
      getAccessToken: () => "member-jwt",
      agentId: "agent/team",
      runtimeSessionToken: "runtime-proof",
    });

    await sdk.submitGithubTaskReply("chat/id", "run/id", { body: "Done." });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud.example/api/v1/agent/chats/chat%2Fid/github-task-runs/run%2Fid/reply");
    expect(new Headers(init?.headers).get("x-agent-id")).toBe("agent/team");
    expect(new Headers(init?.headers).get("x-agent-runtime-session")).toBe("runtime-proof");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "Done." });
  });

  it("does not retry an unknown GitHub mutation response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "delivery unknown", code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://cloud.example",
      getAccessToken: () => "member-jwt",
      agentId: "agent",
      runtimeSessionToken: "runtime-proof",
    });
    await expect(sdk.submitGithubTaskReply("chat", "run", { body: "Done." })).rejects.toMatchObject({
      statusCode: 502,
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
      message: "delivery unknown",
    } satisfies Partial<SdkError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
