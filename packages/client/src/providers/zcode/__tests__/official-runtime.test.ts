import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOfficialZcodeRuntime,
  OFFICIAL_ZCODE_RUNTIME_CONTRACT,
  type OfficialZcodeRuntimeContract,
} from "../official-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function arMember(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(60);
  header.write(`${name}/`.padEnd(16, " "), 0, 16, "binary");
  header.write(sizeText(content.length), 48, "binary");
  header.write("\x60\x0a", 58, "binary");
  const padding = content.length % 2 === 0 ? Buffer.alloc(0) : Buffer.from("\n");
  return Buffer.concat([header, content, padding]);
}

function sizeText(size: number): string {
  const value = String(size);
  if (value.length > 10) throw new Error("test archive member is too large");
  return value.padStart(10, "0");
}

function testContract(runtime: Buffer, artifact: Buffer): OfficialZcodeRuntimeContract {
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  return {
    artifactUrl: "https://zcode.example.test/ZCode.deb",
    platform: "linux-x64",
    packageVersion: "test-package",
    runtimePath: "./opt/ZCode/resources/glm/zcode.cjs",
    artifact: { sha256: hash(artifact), bytes: artifact.length },
    runtime: { sha256: hash(runtime), bytes: runtime.length },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ft-zcode-official-"));
  roots.push(root);
  return root;
}

describe("ensureOfficialZcodeRuntime", () => {
  it("downloads, digest-checks, extracts, and atomically installs the managed runtime", async () => {
    const runtime = Buffer.from("official-runtime-bytes");
    const artifact = Buffer.concat([
      Buffer.from("!<arch>\n"),
      arMember("debian-binary", Buffer.from("1")),
      arMember("data.tar.xz", Buffer.from("compressed-payload")),
    ]);
    const cacheRoot = join(await makeRoot(), "runtime");
    const calls: { fetch: number; tar: number } = { fetch: 0, tar: 0 };

    const first = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      fetchImpl: (async () => {
        calls.fetch += 1;
        return new Response(artifact, { status: 200 });
      }) as typeof fetch,
      runTar: async (args, cwd) => {
        calls.tar += 1;
        expect(args.at(-1)).toBe("./opt/ZCode/resources/glm/zcode.cjs");
        expect(args).toContain("--no-same-owner");
        expect(args).toContain("--no-same-permissions");
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    });

    expect(first).toEqual({
      ok: true,
      command: process.execPath,
      args: [join(cacheRoot, "zcode.cjs")],
      runtimePath: join(cacheRoot, "zcode.cjs"),
    });
    expect(calls).toEqual({ fetch: 1, tar: 1 });
    const manifest = JSON.parse(await readFile(join(cacheRoot, "manifest.json"), "utf8"));
    expect(manifest.schema).toBe("first-tree.zcode-official-runtime.v1");

    const second = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      fetchImpl: (async () => {
        calls.fetch += 1;
        throw new Error("must use the valid cache");
      }) as typeof fetch,
      runTar: async () => {
        calls.tar += 1;
      },
    });
    expect(second).toEqual(first);
    expect(calls).toEqual({ fetch: 1, tar: 1 });
  });

  it("rejects a downloaded artifact whose digest does not match and removes the cache", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    let tarCalls = 0;
    const malicious = Buffer.concat([Buffer.from("tampered"), Buffer.alloc(Buffer.from("malicious").length - 8)]);
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("expected"), Buffer.from("malicious")),
      fetchImpl: (async () => new Response(malicious, { status: 200 })) as typeof fetch,
      runTar: async () => {
        tarCalls += 1;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("official ZCode artifact SHA-256 mismatch"),
    });
    expect(tarCalls).toBe(0);
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a malformed ar artifact before invoking tar", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    const artifact = Buffer.from("not-an-archive");
    let tarCalls = 0;
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("runtime"), artifact),
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async () => {
        tarCalls += 1;
      },
    });
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(tarCalls).toBe(0);
  });

  it("fails closed when the pinned member does not extract a runtime", async () => {
    const runtime = Buffer.from("official-runtime-bytes");
    const artifact = Buffer.concat([
      Buffer.from("!<arch>\n"),
      arMember("data.tar.xz", Buffer.from("payload-without-runtime")),
    ]);
    const cacheRoot = join(await makeRoot(), "runtime");
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async () => {},
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("the pinned runtime member was not extracted"),
    });
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on any host platform outside the pinned official artifact", async () => {
    let fetchCalls = 0;
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot: "/should-not-be-written",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not download");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("pinned to linux-x64"),
    });
    expect(fetchCalls).toBe(0);
  });

  it("keeps the production contract tied to the verified official provider artifact", () => {
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.artifactUrl).toBe(
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.10.2/linux-x64/ZCode-3.10.2-linux-x64.deb",
    );
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.artifact.sha256).toBe(
      "b618cfa70c8f7c8a1a6e2950565cc441c298b801bb2389c292eb0d3add6bf0c0",
    );
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.runtime.sha256).toBe(
      "3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc",
    );
  });
});
