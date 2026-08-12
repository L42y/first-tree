import { describe, expect, it } from "vitest";
import { buildBotEnvironment, isUncontrolledMessageMutation, retryableFailure } from "../feishu-cli-policy.js";

describe("Feishu CLI policy", () => {
  it.each([
    [["im", "messages", "create"], true],
    [["im", "messages", "delete"], true],
    [["im", "+messages-send"], false],
    [["im", "+messages-reply"], false],
    [["api", "POST", "/open-apis/im/v1/messages"], true],
    [["api", "POST", "/open-apis/im/v1/messages/om_1/reply"], true],
    [["api", "GET", "/open-apis/im/v1/messages/om_1"], false],
    [["docs", "list"], false],
  ] as const)("classifies %j as blocked=%s", (args, blocked) => {
    expect(isUncontrolledMessageMutation(args)).toBe(blocked);
  });

  it("retries only transient failures", () => {
    expect(retryableFailure({ code: 1, stdout: "", stderr: "HTTP 429", timedOut: false })).toBe(true);
    expect(retryableFailure({ code: 1, stdout: "", stderr: "ECONNRESET", timedOut: false })).toBe(true);
    expect(retryableFailure({ code: 1, stdout: "", stderr: "HTTP 503", timedOut: false })).toBe(true);
    expect(retryableFailure({ code: 1, stdout: "", stderr: "invalid app secret", timedOut: false })).toBe(false);
    expect(retryableFailure({ code: 1, stdout: "", stderr: "permission denied", timedOut: false })).toBe(false);
    expect(retryableFailure({ code: 1, stdout: "", stderr: "", timedOut: true })).toBe(true);
  });

  it("scopes the Agent-owned App Secret to the official CLI child environment", () => {
    const parent = {
      PATH: "/usr/bin",
      LARKSUITE_CLI_USER_ACCESS_TOKEN: "wrong-user",
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "stale-tenant",
    };
    const env = buildBotEnvironment(parent, "cli_app", "agent-owned-secret");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      LARKSUITE_CLI_APP_ID: "cli_app",
      LARKSUITE_CLI_APP_SECRET: "agent-owned-secret",
    });
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBeUndefined();
    expect(parent.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("wrong-user");
  });
});
