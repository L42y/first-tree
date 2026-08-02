import { describe, expect, it } from "vitest";
import { agentTemplateIntentPath, parseAgentTemplateIntentPath } from "../agent-template-intent.js";

describe("agentTemplateIntentPath", () => {
  it("builds the canonical intent URL", () => {
    expect(agentTemplateIntentPath("pr-engineer")).toBe("/templates/pr-engineer?use=1");
  });
});

describe("parseAgentTemplateIntentPath", () => {
  it("accepts the strict canonical intent URL", () => {
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?use=1")).toBe("pr-engineer");
  });

  it("round-trips the builder output", () => {
    expect(parseAgentTemplateIntentPath(agentTemplateIntentPath("docs-writer"))).toBe("docs-writer");
  });

  it("rejects an invalid slug", () => {
    expect(parseAgentTemplateIntentPath("/templates/PR_Engineer?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/-leading-dash?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath(`/templates/${"a".repeat(101)}?use=1`)).toBeNull();
  });

  it("rejects extra or missing query parameters", () => {
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?use=0")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?use=1&campaign=x")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?campaign=x&use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?use=1&use=1")).toBeNull();
  });

  it("rejects a fragment", () => {
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer?use=1#section")).toBeNull();
  });

  it("rejects nested paths and other routes", () => {
    expect(parseAgentTemplateIntentPath("/templates/pr-engineer/extra?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/quickstart?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/")).toBeNull();
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(parseAgentTemplateIntentPath("https://evil.example/templates/pr-engineer?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("//evil.example/templates/pr-engineer?use=1")).toBeNull();
  });

  it("rejects path traversal and encoded separators", () => {
    expect(parseAgentTemplateIntentPath("/templates/../settings?use=1")).toBeNull();
    expect(parseAgentTemplateIntentPath("/templates/a%2Fb?use=1")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(parseAgentTemplateIntentPath("")).toBeNull();
    expect(parseAgentTemplateIntentPath("not a url at all:::")).toBeNull();
  });
});
