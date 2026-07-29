import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findOpenCodeExecutableOnPath,
  formatOpenCodeBinaryMissingMessage,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "../runtime/opencode-binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode binary resolution", () => {
  it("finds the operator-installed binary without launching it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-bin-"));
    roots.push(root);
    const binary = join(root, "opencode");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findOpenCodeExecutableOnPath(
        { PATH: root },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("resolves without launching; the handler performs its gate through the process supervisor", () => {
    const result = resolveOpenCodeRuntimeBinary({}, { findOnPath: () => "/opt/bin/opencode" });
    expect(result).toEqual({ ok: true, binary: "/opt/bin/opencode" });
  });

  it("resolves npm's native Windows executable instead of the opencode.cmd shim", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-win-bin-"));
    roots.push(root);
    const native = join(root, "node_modules", "opencode-ai", "bin", "opencode.exe");
    mkdirSync(join(root, "node_modules", "opencode-ai", "bin"), { recursive: true });
    writeFileSync(join(root, "opencode.cmd"), "@echo off\r\n");
    writeFileSync(native, "native");

    expect(
      findOpenCodeExecutableOnPath(
        { PATH: root },
        {
          platform: "win32",
          pathDelimiter: ";",
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(native);
  });

  it("surfaces external install and provider-owned auth instructions", () => {
    expect(formatOpenCodeBinaryMissingMessage("not found")).toContain("npm install -g opencode-ai@1.18.7");
    expect(formatOpenCodeBinaryMissingMessage("not found")).toContain("opencode auth login");
  });

  it("parses the exact version gate output without executing a binary", () => {
    expect(parseOpenCodeVersionOutput("opencode 1.18.7")).toBe("1.18.7");
    expect(parseOpenCodeVersionOutput("not-a-version")).toBeNull();
  });
});
