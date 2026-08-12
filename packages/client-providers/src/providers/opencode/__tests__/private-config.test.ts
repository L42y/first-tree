import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOpenCodePrivateConfigLease } from "../private-config.js";

const roots: string[] = [];
const callerScope = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode private config lease", () => {
  it("rejects a symlinked managed ancestor without touching its external target", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ft-opencode-private-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "ft-opencode-private-external-"));
    roots.push(workspace, external);
    const managedRoot = join(workspace, ".first-tree-workspace");
    mkdirSync(managedRoot);
    writeFileSync(join(external, "sentinel.txt"), "outside");
    symlinkSync(external, join(managedRoot, "opencode-config"), "dir");

    await expect(
      acquireOpenCodePrivateConfigLease({
        workspace,
        callerScope,
        handlerId: "1".repeat(32),
      }),
    ).rejects.toThrow(/symlink/i);
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("outside");
  });

  it("keeps a newer handler generation alive when an older handler shuts down late", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ft-opencode-private-generations-"));
    roots.push(workspace);
    const older = await acquireOpenCodePrivateConfigLease({
      workspace,
      callerScope,
      handlerId: "2".repeat(32),
    });
    const newer = await acquireOpenCodePrivateConfigLease({
      workspace,
      callerScope,
      handlerId: "3".repeat(32),
    });
    const materialization = newer.materialize("newer");
    const callerParent = join(workspace, ".first-tree-workspace", "opencode-config", callerScope);
    const generationNames = () => readdirSync(callerParent).filter((name) => /^handler-[a-f0-9]{32}$/.test(name));
    expect(generationNames()).toHaveLength(2);

    await older.close();

    expect(generationNames()).toHaveLength(1);
    expect(readFileSync(materialization.configPath, "utf8")).toBe("newer");
    materialization.cleanup();
    await newer.close();
    expect(generationNames()).toEqual([]);
  });

  it("sweeps a journaled crashed generation and an unjournaled orphan under the caller lock", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ft-opencode-private-stale-"));
    roots.push(workspace);
    const callerParent = join(workspace, ".first-tree-workspace", "opencode-config", callerScope);
    const staleId = "4".repeat(32);
    const orphanId = "5".repeat(32);
    mkdirSync(join(callerParent, `handler-${staleId}`), { recursive: true });
    mkdirSync(join(callerParent, `handler-${orphanId}`), { recursive: true });
    writeFileSync(
      join(callerParent, "handler-generations.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            handlerId: staleId,
            pid: process.pid,
            processInstanceId: "stale-process-instance",
            createdAt: new Date(0).toISOString(),
          },
        ],
      })}\n`,
    );

    const current = await acquireOpenCodePrivateConfigLease({
      workspace,
      callerScope,
      handlerId: "6".repeat(32),
    });

    expect(existsSync(join(callerParent, `handler-${staleId}`))).toBe(false);
    expect(existsSync(join(callerParent, `handler-${orphanId}`))).toBe(false);
    expect(readdirSync(callerParent).some((name) => /^handler-[a-f0-9]{32}$/.test(name))).toBe(true);
    await current.close();
  });
});
