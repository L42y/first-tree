import { describe, expect, it } from "vitest";
import { OPENTAG_ENTRY_PATH, opentagEntryPath, parseOpenTagEntryPath } from "../opentag-entry.js";

const AGENT_UUID = "0198b2c4-1f6a-7c31-9a02-4d5e6f708192";

describe("opentagEntryPath", () => {
  it("builds the bare entry when no Agent is carried", () => {
    expect(opentagEntryPath()).toBe(OPENTAG_ENTRY_PATH);
    expect(opentagEntryPath(null)).toBe("/opentag");
  });

  it("builds the Agent-scoped entry", () => {
    expect(opentagEntryPath(AGENT_UUID)).toBe(`/opentag?agent=${AGENT_UUID}`);
  });
});

describe("parseOpenTagEntryPath", () => {
  it("accepts the bare entry", () => {
    expect(parseOpenTagEntryPath("/opentag")).toEqual({ agentUuid: null });
  });

  it("accepts the Agent-scoped entry the builder produces", () => {
    expect(parseOpenTagEntryPath(opentagEntryPath(AGENT_UUID))).toEqual({ agentUuid: AGENT_UUID });
  });

  it("rejects a non-canonical spelling of the same destination", () => {
    // Uppercase resolves to a different Agent id string, so it is not the
    // builder's exact output even though a server might treat it as equal.
    expect(parseOpenTagEntryPath(`/opentag?agent=${AGENT_UUID.toUpperCase()}`)).toBeNull();
    expect(parseOpenTagEntryPath("/opentag/")).toBeNull();
    expect(parseOpenTagEntryPath("/opentag?")).toBeNull();
    expect(parseOpenTagEntryPath(`/opentag?agent=${AGENT_UUID}&`)).toBeNull();
    expect(parseOpenTagEntryPath(`/opentag?agent=${AGENT_UUID}#step`)).toBeNull();
  });

  it("rejects an unknown or extra query parameter", () => {
    expect(parseOpenTagEntryPath("/opentag?step=runtime")).toBeNull();
    expect(parseOpenTagEntryPath(`/opentag?agent=${AGENT_UUID}&step=runtime`)).toBeNull();
  });

  it("rejects an agent value that is not a UUID", () => {
    expect(parseOpenTagEntryPath("/opentag?agent=not-a-uuid")).toBeNull();
    expect(parseOpenTagEntryPath("/opentag?agent=")).toBeNull();
  });

  it("rejects anything that is not the same-origin OpenTag path", () => {
    expect(parseOpenTagEntryPath("https://evil.example/opentag")).toBeNull();
    expect(parseOpenTagEntryPath("//evil.example/opentag")).toBeNull();
    expect(parseOpenTagEntryPath("/opentagged")).toBeNull();
    expect(parseOpenTagEntryPath("/onboarding")).toBeNull();
    expect(parseOpenTagEntryPath("")).toBeNull();
  });
});
