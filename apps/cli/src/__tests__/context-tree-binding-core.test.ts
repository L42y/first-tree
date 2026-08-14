import { SdkError } from "@first-tree/client";
import { describe, expect, it, vi } from "vitest";
import { AuthRefreshFailedError } from "../core/bootstrap.js";
import {
  ContextTreeUnreadableError,
  classifyContextTreeReadError,
  normalizeContextTreeBinding,
  readAgentContextTreeBinding,
} from "../core/context-tree-binding.js";

describe("Context Tree binding core", () => {
  it("normalizes bound HTTPS, SSH URL, and scp-like responses", () => {
    expect(
      normalizeContextTreeBinding({
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "release",
        provider: "github",
      }),
    ).toEqual({
      status: "bound",
      repo: "https://github.com/acme/context-tree.git",
      branch: "release",
    });

    expect(
      normalizeContextTreeBinding({
        bindingState: "bound",
        repo: "ssh://git@gitlab.com/acme/context-tree.git",
        branch: "main",
        provider: "gitlab",
      }),
    ).toEqual({
      status: "bound",
      repo: "ssh://git@gitlab.com/acme/context-tree.git",
      branch: "main",
    });

    expect(
      normalizeContextTreeBinding({
        bindingState: "bound",
        repo: "ssh://git@example.com/acme/context-tree.git",
        branch: "main",
        provider: null,
      }),
    ).toEqual({
      status: "bound",
      repo: "ssh://git@example.com/acme/context-tree.git",
      branch: "main",
    });

    expect(
      normalizeContextTreeBinding({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "trunk",
        provider: "github",
      }),
    ).toEqual({
      status: "bound",
      repo: "git@github.com:acme/context-tree.git",
      branch: "trunk",
    });
  });

  it("requires explicit unbound state with no usable remote coordinates", () => {
    expect(
      normalizeContextTreeBinding({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
    ).toEqual({
      status: "unbound",
      repo: null,
      branch: "main",
    });

    expect(normalizeContextTreeBinding({ bindingState: "invalid", repo: null, branch: null, provider: null })).toEqual({
      status: "invalid",
      repo: null,
      branch: null,
    });

    expect(() =>
      normalizeContextTreeBinding({ bindingState: "bound", repo: "", branch: "main", provider: "github" }),
    ).toThrow(ContextTreeUnreadableError);
    expect(() =>
      normalizeContextTreeBinding({
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "",
        provider: "github",
      }),
    ).toThrow(ContextTreeUnreadableError);
  });

  it.each([
    ["missing repo", { bindingState: "bound", branch: "main", provider: "github" }],
    [
      "bound response without branch",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        provider: "github",
      },
    ],
    [
      "bound response with null branch",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: null,
        provider: "github",
      },
    ],
    ["legacy response without bindingState", { repo: null, branch: null }],
    ["legacy response without required provider", { bindingState: "unbound", repo: null, branch: "main" }],
    [
      "unbound response without its default branch",
      { bindingState: "unbound", repo: null, branch: null, provider: null },
    ],
    [
      "invalid response with usable provider coordinates",
      { bindingState: "invalid", repo: null, branch: null, provider: "github" },
    ],
    [
      "invalid repo URL",
      { bindingState: "bound", repo: "http://github.com/acme/context-tree.git", branch: "main", provider: "github" },
    ],
    [
      "missing repo host",
      { bindingState: "bound", repo: "ssh:///acme/context-tree.git", branch: "main", provider: "github" },
    ],
    ["missing repo path", { bindingState: "bound", repo: "https://github.com", branch: "main", provider: "github" }],
    [
      "padded repo",
      {
        bindingState: "bound",
        repo: " https://github.com/acme/context-tree.git",
        branch: "main",
        provider: "github",
      },
    ],
    [
      "multiline repo",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git\nforged",
        branch: "main",
        provider: "github",
      },
    ],
    [
      "padded branch",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: " main",
        provider: "github",
      },
    ],
    [
      "multiline branch",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main\nforged",
        provider: "github",
      },
    ],
    [
      "Git-invalid branch",
      {
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "feature..next",
        provider: "github",
      },
    ],
    ["invalid response shape", ["not", "an", "object"]],
  ])("rejects %s as an unreadable response", (_label, response) => {
    expect(() => normalizeContextTreeBinding(response)).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_TREE_UNREADABLE",
        status: "unreadable",
        category: "invalid-response",
        exitCode: 1,
      }),
    );
  });

  it("reads once through the supplied SDK and emits structured debug logs", async () => {
    const getAgentContextTreeConfig = vi.fn(async () => ({
      bindingState: "bound",
      repo: "git@github.com:acme/context-tree.git",
      branch: "main",
      provider: "github",
    }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      readAgentContextTreeBinding(
        { agentId: "agent-uuid", getAgentContextTreeConfig },
        { agent: "agent-name", logger },
      ),
    ).resolves.toEqual({
      status: "bound",
      repo: "git@github.com:acme/context-tree.git",
      branch: "main",
    });

    expect(getAgentContextTreeConfig).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenNthCalledWith(1, { agent: "agent-name" }, "reading agent Context Tree binding");
    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      { agent: "agent-name", status: "bound" },
      "normalized agent Context Tree binding",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "HTTP authentication",
      error: new SdkError(401, "raw authentication response must stay private"),
      expected: { category: "authentication", exitCode: 3, httpStatus: 401 },
    },
    {
      label: "refresh authentication",
      error: new AuthRefreshFailedError("raw refresh response must stay private"),
      expected: { category: "authentication", exitCode: 3 },
    },
    {
      label: "remote HTTP",
      error: new SdkError(503, "raw upstream response must stay private"),
      expected: { category: "remote", exitCode: 1, httpStatus: 503 },
    },
    {
      label: "connection",
      error: new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNREFUSED" }) }),
      expected: { category: "connection", exitCode: 6 },
    },
    {
      label: "timeout",
      error: new DOMException("request timed out", "TimeoutError"),
      expected: { category: "timeout", exitCode: 6 },
    },
    {
      label: "nested timeout",
      error: Object.assign(new Error("request failed"), {
        cause: Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" }),
      }),
      expected: { category: "timeout", exitCode: 6 },
    },
    {
      label: "invalid JSON",
      error: new SyntaxError("Unexpected token containing raw response"),
      expected: { category: "invalid-response", exitCode: 1 },
    },
    {
      label: "unknown",
      error: new Error("private unknown detail"),
      expected: { category: "unknown", exitCode: 1 },
    },
  ])("classifies $label failures without exposing their source message", ({ error, expected }) => {
    const classified = classifyContextTreeReadError(error);
    expect(classified).toMatchObject({
      code: "CONTEXT_TREE_UNREADABLE",
      status: "unreadable",
      ...expected,
    });
    expect(classified.message).not.toContain(error.message);
  });

  it("logs only sanitized failure metadata before rethrowing an unreadable error", async () => {
    const rawBody = "secret raw server response";
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const sdk = {
      agentId: "agent-uuid",
      getAgentContextTreeConfig: vi.fn(async () => {
        throw new SdkError(500, rawBody);
      }),
    };

    await expect(readAgentContextTreeBinding(sdk, { logger })).rejects.toMatchObject({
      code: "CONTEXT_TREE_UNREADABLE",
      status: "unreadable",
      category: "remote",
      exitCode: 1,
      httpStatus: 500,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { agent: "agent-uuid", category: "remote", exitCode: 1, httpStatus: 500 },
      "agent Context Tree binding is unreadable",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(rawBody);
  });
});
