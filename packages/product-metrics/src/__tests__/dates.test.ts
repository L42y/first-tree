import { describe, expect, it } from "vitest";
import { compareInstants, parseInstant } from "../dates.js";

describe("parseInstant", () => {
  it("accepts ISO and PostgreSQL timestamps with explicit offsets", () => {
    expect(parseInstant("2026-07-27T09:57:31.963977Z", "instant").toISOString()).toBe("2026-07-27T09:57:31.963Z");
    expect(parseInstant("2026-07-27 09:57:31.963977+00", "instant").toISOString()).toBe("2026-07-27T09:57:31.963Z");
    expect(parseInstant("2026-07-27T17:57:31+08", "instant").toISOString()).toBe("2026-07-27T09:57:31.000Z");
    expect(parseInstant("2026-07-27T17:57:31+08:00", "instant").toISOString()).toBe("2026-07-27T09:57:31.000Z");
  });

  it("rejects environment-dependent timestamps without an offset", () => {
    expect(() => parseInstant("2026-07-27", "instant")).toThrow("complete ISO-8601 timestamp");
    expect(() => parseInstant("2026-07-27T09:57:31", "instant")).toThrow("explicit UTC offset");
  });

  it("rejects impossible calendar, clock, and offset components", () => {
    expect(() => parseInstant("2026-02-30T09:00:00Z", "instant")).toThrow("real calendar date");
    expect(() => parseInstant("2026-07-27T24:00:00Z", "instant")).toThrow("valid clock time");
    expect(() => parseInstant("2026-07-27T09:60:00Z", "instant")).toThrow("valid clock time");
    expect(() => parseInstant("2026-07-27T09:00:60Z", "instant")).toThrow("valid clock time");
    expect(() => parseInstant("2026-07-27T09:00:00+15:00", "instant")).toThrow("valid UTC offset");
    expect(() => parseInstant("2026-07-27T09:00:00+14:01", "instant")).toThrow("valid UTC offset");
    expect(() => parseInstant("2026-07-27T09:00:00+08:60", "instant")).toThrow("valid UTC offset");
  });

  it("preserves sub-millisecond ordering and normalizes offsets", () => {
    expect(compareInstants("2026-07-27T09:57:31.963100Z", "2026-07-27T09:57:31.963900Z")).toBe(-1);
    expect(compareInstants("2026-07-27T17:57:31.963900+08:00", "2026-07-27T09:57:31.963900Z")).toBe(0);
  });
});
