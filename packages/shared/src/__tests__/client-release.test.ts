import { describe, expect, it } from "vitest";
import { supportsRuntimeSwitchClientVersion } from "../client-release.js";

describe("supportsRuntimeSwitchClientVersion", () => {
  it.each([
    "0.5.12",
    "v0.5.12",
    "0.5.19",
    "0.5.12+build.1",
    "0.5.13-staging.1.1",
    "0.5.20-staging.123.1",
  ])("accepts supported release %s", (version) => {
    expect(supportsRuntimeSwitchClientVersion(version)).toBe(true);
  });

  it.each([
    null,
    "",
    "0.5.11",
    "0.14.8",
    "0.5.012",
    "0.5.12-staging.123.1",
    "0.5.20-staging.0.1",
    "0.5.20-staging.123.0",
    "0.5.20-staging.0123.1",
    "0.5.12-beta.1",
    "invalid",
  ])("rejects unsupported release %s", (version) => {
    expect(supportsRuntimeSwitchClientVersion(version)).toBe(false);
  });
});
