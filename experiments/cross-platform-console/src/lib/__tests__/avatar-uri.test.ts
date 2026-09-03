import { describe, expect, it } from "vitest";

import { resolveAvatarUri } from "../avatar-uri";

const BASE = "https://dev.cloud.first-tree.ai";

describe("avatar uri", () => {
  it("puts the API host in front of a server-relative upload path", () => {
    expect(resolveAvatarUri("/api/v1/agents/abc/avatar?v=17", BASE)).toBe(
      "https://dev.cloud.first-tree.ai/api/v1/agents/abc/avatar?v=17",
    );
    // A trailing slash on the base must not double up.
    expect(resolveAvatarUri("/api/v1/x", "https://host/")).toBe("https://host/api/v1/x");
  });

  it("leaves an already-absolute avatar alone", () => {
    expect(resolveAvatarUri("https://avatars.githubusercontent.com/u/1?v=4", BASE)).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
    expect(resolveAvatarUri("//cdn.example.com/a.png", BASE)).toBe("//cdn.example.com/a.png");
    expect(resolveAvatarUri("data:image/png;base64,AAA", BASE)).toBe("data:image/png;base64,AAA");
  });

  it("treats a missing or blank url as no avatar", () => {
    expect(resolveAvatarUri(null, BASE)).toBeNull();
    expect(resolveAvatarUri(undefined, BASE)).toBeNull();
    expect(resolveAvatarUri("   ", BASE)).toBeNull();
  });
});
