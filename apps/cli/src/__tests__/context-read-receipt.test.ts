import { describe, expect, it } from "vitest";
import { contextReadCommand } from "../commands/context/read.js";
import { contextWriteCommand } from "../commands/context/write.js";

describe("external Context read route receipt", () => {
  it("materializes only an opaque SCOPE-selected candidate", () => {
    expect(contextReadCommand.description).toContain("SCOPE route receipt");
    expect(contextReadCommand.name).toBe("snapshot");
    expect(contextReadCommand.alias).toBe("");
    expect(contextWriteCommand.name).toBe("write-preflight");
    expect(contextWriteCommand.alias).toBe("");
  });
});
