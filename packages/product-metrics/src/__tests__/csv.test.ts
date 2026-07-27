import { describe, expect, it } from "vitest";
import { optionalColumn, parseCsv } from "../csv.js";

describe("parseCsv", () => {
  it("parses quoted commas, quotes, CRLF, and a UTF-8 BOM", () => {
    expect(parseCsv('\uFEFFid,note\r\n1,"hello, ""tree"""\r\n')).toEqual([{ id: "1", note: 'hello, "tree"' }]);
  });

  it("rejects rows with a different number of fields", () => {
    expect(() => parseCsv("a,b\n1\n")).toThrow("expected 2");
  });

  it("accepts pgAdmin's unquoted NULL marker for optional fields", () => {
    expect(optionalColumn(parseCsv("optional\nNULL\n")[0] ?? {}, "optional")).toBeNull();
  });

  it("rejects characters after a closing quote", () => {
    expect(() => parseCsv('value\n"closed"tail\n')).toThrow("after a closing CSV quote");
  });
});
