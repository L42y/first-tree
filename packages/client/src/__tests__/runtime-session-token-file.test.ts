import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestRuntimeSessionToken, RuntimeSessionTokenFile } from "../runtime/runtime-session-token-file.js";

const roots: string[] = [];

function makeTokenPath(): string {
  const root = mkdtempSync(join(tmpdir(), "first-tree-runtime-token-"));
  roots.push(root);
  return join(root, "runtime-session-tokens", "agent-1.token");
}

describe("RuntimeSessionTokenFile", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically writes pure token text at the stable path with private modes", () => {
    const tokenPath = makeTokenPath();
    const store = new RuntimeSessionTokenFile(tokenPath);

    const digest = store.persist("runtime-token-A");

    expect(digest).toBe(digestRuntimeSessionToken("runtime-token-A"));
    expect(readFileSync(tokenPath, "utf8")).toBe("runtime-token-A\n");
    expect(store.read()).toBe("runtime-token-A");
    expect(readdirSync(join(tokenPath, "..")).sort()).toEqual(["agent-1.token"]);
    if (process.platform !== "win32") {
      expect(statSync(join(tokenPath, "..")).mode & 0o777).toBe(0o700);
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves B when B replaces A before A cleanup acquires the mutation lock", () => {
    const tokenPath = makeTokenPath();
    const slotA = new RuntimeSessionTokenFile(tokenPath);
    const slotB = new RuntimeSessionTokenFile(tokenPath);
    const digestA = slotA.persist("runtime-token-A");

    const digestB = slotB.persist("runtime-token-B");

    expect(slotA.removeIfOwned(digestA)).toBe("mismatch");
    expect(slotB.read()).toBe("runtime-token-B");
    expect(slotB.removeIfOwned(digestB)).toBe("removed");
    expect(existsSync(tokenPath)).toBe(false);
  });

  it("waits for a cross-process A cleanup before writing B as the final generation", async () => {
    const tokenPath = makeTokenPath();
    const slotA = new RuntimeSessionTokenFile(tokenPath);
    slotA.persist("runtime-token-A");
    const lockPath = `${tokenPath}.lock`;
    const script = [
      'import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";',
      "const [lockPath, tokenPath] = process.argv.slice(1);",
      'const descriptor = openSync(lockPath, "wx", 0o600);',
      'writeFileSync(descriptor, String(process.pid) + "\\n", "utf8");',
      'process.stdout.write("locked\\n");',
      "setTimeout(() => {",
      "  rmSync(tokenPath);",
      "  closeSync(descriptor);",
      "  rmSync(lockPath);",
      "}, 75);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath, tokenPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout, "data");
    const slotB = new RuntimeSessionTokenFile(tokenPath, {
      lockAcquireTimeoutMs: 1_000,
      lockRetryDelayMs: 2,
    });

    slotB.persist("runtime-token-B");

    expect(slotB.read()).toBe("runtime-token-B");
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });

  it("waits for a cross-process B mutation before comparing A ownership", async () => {
    const tokenPath = makeTokenPath();
    const slotA = new RuntimeSessionTokenFile(tokenPath, {
      lockAcquireTimeoutMs: 1_000,
      lockRetryDelayMs: 2,
    });
    const digestA = slotA.persist("runtime-token-A");
    const lockPath = `${tokenPath}.lock`;
    const script = [
      'import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";',
      "const [lockPath, tokenPath] = process.argv.slice(1);",
      'const descriptor = openSync(lockPath, "wx", 0o600);',
      'writeFileSync(descriptor, String(process.pid) + "\\n", "utf8");',
      'process.stdout.write("locked\\n");',
      "setTimeout(() => {",
      '  const temporaryPath = tokenPath + ".child-tmp";',
      '  writeFileSync(temporaryPath, "runtime-token-B\\n", { mode: 0o600 });',
      "  renameSync(temporaryPath, tokenPath);",
      "  closeSync(descriptor);",
      "  rmSync(lockPath);",
      "}, 75);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath, tokenPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout, "data");

    expect(slotA.removeIfOwned(digestA)).toBe("mismatch");
    expect(slotA.read()).toBe("runtime-token-B");

    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });

  it("fails closed while another process holds the mutation lock", async () => {
    const tokenPath = makeTokenPath();
    mkdirSync(join(tokenPath, ".."), { recursive: true, mode: 0o700 });
    const lockPath = `${tokenPath}.lock`;
    const script = [
      'import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";',
      "const lockPath = process.argv[1];",
      'const descriptor = openSync(lockPath, "wx", 0o600);',
      'writeFileSync(descriptor, String(process.pid) + "\\n", "utf8");',
      'process.stdout.write("locked\\n");',
      "setTimeout(() => {",
      "  closeSync(descriptor);",
      "  rmSync(lockPath);",
      "}, 150);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout, "data");
    const store = new RuntimeSessionTokenFile(tokenPath, {
      lockAcquireTimeoutMs: 20,
      lockRetryDelayMs: 2,
    });

    expect(() => store.persist("runtime-token-A")).toThrow(/Timed out acquiring/);
    expect(existsSync(tokenPath)).toBe(false);

    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });

  it("fails both contenders closed when they race over the same stale lock", async () => {
    const tokenPath = makeTokenPath();
    mkdirSync(join(tokenPath, ".."), { recursive: true, mode: 0o700 });
    const lockPath = `${tokenPath}.lock`;
    writeFileSync(lockPath, "99999999\n", { mode: 0o600 });
    const moduleUrl = new URL("../runtime/runtime-session-token-file.ts", import.meta.url).href;
    const script = [
      "const [moduleUrl, tokenPath, token] = process.argv.slice(1);",
      "const { RuntimeSessionTokenFile } = await import(moduleUrl);",
      "const store = new RuntimeSessionTokenFile(tokenPath, {",
      "  lockAcquireTimeoutMs: 50,",
      "  lockRetryDelayMs: 2,",
      "});",
      "try {",
      "  store.persist(token);",
      '  process.stdout.write("acquired\\n");',
      "} catch {",
      '  process.stdout.write("blocked\\n");',
      "}",
    ].join("\n");
    const spawnContender = (token: string) =>
      spawn(
        process.execPath,
        [
          "--no-warnings",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          moduleUrl,
          tokenPath,
          token,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    const contenderB = spawnContender("runtime-token-B");
    const contenderC = spawnContender("runtime-token-C");
    const outputB = once(contenderB.stdout, "data");
    const outputC = once(contenderC.stdout, "data");
    const exitB = once(contenderB, "exit");
    const exitC = once(contenderC, "exit");

    const [[chunkB], [chunkC], [exitCodeB], [exitCodeC]] = await Promise.all([outputB, outputC, exitB, exitC]);

    expect(exitCodeB).toBe(0);
    expect(exitCodeC).toBe(0);
    expect(String(chunkB).trim()).toBe("blocked");
    expect(String(chunkC).trim()).toBe("blocked");
    expect(readFileSync(lockPath, "utf8")).toBe("99999999\n");
    expect(existsSync(tokenPath)).toBe(false);
  });

  it("removes only a readable, non-empty matching generation", () => {
    const tokenPath = makeTokenPath();
    const store = new RuntimeSessionTokenFile(tokenPath);
    const digestA = store.persist("runtime-token-A");

    rmSync(tokenPath);
    expect(store.removeIfOwned(digestA)).toBe("missing");

    writeFileSync(tokenPath, "\n", { mode: 0o600 });
    expect(store.removeIfOwned(digestA)).toBe("empty");
    expect(existsSync(tokenPath)).toBe(true);

    writeFileSync(tokenPath, "runtime-token-B\n", { mode: 0o600 });
    expect(store.removeIfOwned(digestA)).toBe("mismatch");
    expect(store.read()).toBe("runtime-token-B");

    rmSync(tokenPath);
    mkdirSync(tokenPath);
    expect(() => store.removeIfOwned(digestA)).toThrow(/Failed to read/);
    expect(statSync(tokenPath).isDirectory()).toBe(true);
  });

  it("preserves the target and removes temporary files when atomic replacement fails", () => {
    const tokenPath = makeTokenPath();
    mkdirSync(tokenPath, { recursive: true });
    const failingStore = new RuntimeSessionTokenFile(tokenPath);

    expect(() => failingStore.persist("runtime-token-B")).toThrow();

    expect(statSync(tokenPath).isDirectory()).toBe(true);
    expect(
      readdirSync(join(tokenPath, "..")).filter((entry) => entry.includes(".tmp.") || entry.endsWith(".lock")),
    ).toEqual([]);
  });
});
