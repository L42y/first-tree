import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";
import { channelConfig } from "../core/channel.js";

const output = vi.hoisted(() => ({
  result: vi.fn(),
  fail: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../core/output.js", () => ({ print: output }));

import { runContextDisable } from "../commands/context/disable.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
  writeContextBinding,
} from "../core/context-integration/context-binding-store.js";

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

function setup(): { home: string; project: string; nested: string } {
  const home = mkdtempSync(join(tmpdir(), "first-tree-context-disable-"));
  const project = join(home, "project");
  const nested = join(project, "packages", "api");
  roots.push(home);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(home, "config", "credentials.json"),
    JSON.stringify({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://first-tree.test" }),
  );
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  return { home, project, nested };
}

function context(options: Record<string, unknown>, json = false): CommandContext {
  return {
    command: { opts: () => options } as unknown as Command,
    options: { json, debug: false, quiet: false },
  };
}

describe("context disable command", () => {
  it("removes the deepest effective ancestor binding and preserves other projects", async () => {
    const { project, nested } = setup();
    const parent = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: project },
      organizationId: "org_parent",
    };
    const deepest = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: join(project, "packages") },
      organizationId: "org_deepest",
    };
    const pathless = {
      provider: "codex" as const,
      project: { kind: "pathless" as const },
      organizationId: "org_pathless",
    };
    for (const binding of [parent, deepest, pathless]) writeContextBinding(binding);

    await runContextDisable(context({ provider: "codex", projectRoot: nested, yes: true }));

    expect(findContextBinding("codex", { kind: "path", root: nested })).toEqual(parent);
    expect(readContextIntegrationConfig().bindings).toEqual(expect.arrayContaining([parent, pathless]));
    expect(readContextIntegrationConfig().bindings).not.toContainEqual(deepest);
    expect(output.status).toHaveBeenCalledWith("Project", deepest.project.root);
    expect(output.status).toHaveBeenCalledWith("Team", deepest.organizationId);
    expect(output.status).toHaveBeenCalledWith("Plugin", "keep user-scope Plugin");
    expect(output.status).toHaveBeenCalledWith(
      "Context",
      expect.stringContaining(`parent Project ${parent.project.root} remains active for Team ${parent.organizationId}`),
    );
    expect(output.status).toHaveBeenCalledWith(
      "Next action",
      expect.stringContaining("context disable --provider codex --project-root"),
    );
    expect(output.status).toHaveBeenCalledWith("Current session", "already injected Context cannot be removed");
  });

  it("reports a same-Team parent fallback in JSON instead of claiming disabled", async () => {
    const { project, nested } = setup();
    const parent = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: project },
      organizationId: "org_same",
    };
    const deepest = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: join(project, "packages") },
      organizationId: "org_same",
    };
    writeContextBinding(parent);
    writeContextBinding(deepest);

    await runContextDisable(context({ provider: "codex", projectRoot: nested, yes: true }, true));

    expect(output.result).toHaveBeenCalledWith({
      provider: "codex",
      project: { kind: "path", root: nested },
      status: "fallback_active",
      removed: deepest,
      fallback: parent,
    });
  });

  it.skipIf(process.platform === "win32")(
    "quotes a fallback command as literal POSIX argv without command substitution",
    async () => {
      const { home, project } = setup();
      const dangerousRoot = join(
        project,
        "danger with ' $(touch dollar-substitution-marker) `touch backtick-substitution-marker`",
      );
      const nested = join(dangerousRoot, "src");
      mkdirSync(nested, { recursive: true });
      writeContextBinding({
        provider: "codex",
        project: { kind: "path", root: project },
        organizationId: "org_parent",
      });
      writeContextBinding({
        provider: "codex",
        project: { kind: "path", root: dangerousRoot },
        organizationId: "org_deepest",
      });

      await runContextDisable(context({ provider: "codex", projectRoot: nested, yes: true }));

      const nextAction = output.status.mock.calls.find(([label]) => label === "Next action")?.[1];
      expect(typeof nextAction).toBe("string");
      const shimDir = join(home, "bin");
      const capturedArgs = join(home, "captured-args");
      const shimPath = join(shimDir, channelConfig.binName);
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(shimPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURED_ARGS"\n');
      chmodSync(shimPath, 0o755);
      const executed = spawnSync("/bin/sh", ["-c", String(nextAction)], {
        cwd: home,
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          CAPTURED_ARGS: capturedArgs,
        },
        encoding: "utf8",
      });

      expect(executed.status).toBe(0);
      expect(readFileSync(capturedArgs, "utf8").trimEnd().split("\n")).toEqual([
        "context",
        "disable",
        "--provider",
        "codex",
        "--project-root",
        nested,
      ]);
      expect(existsSync(join(home, "dollar-substitution-marker"))).toBe(false);
      expect(existsSync(join(home, "backtick-substitution-marker"))).toBe(false);
    },
  );

  it("reports disabled when removing a path binding leaves no fallback", async () => {
    const { project, nested } = setup();
    const binding = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: project },
      organizationId: "org_only",
    };
    writeContextBinding(binding);

    await runContextDisable(context({ provider: "codex", projectRoot: nested, yes: true }, true));

    expect(output.result).toHaveBeenCalledWith({
      provider: "codex",
      project: { kind: "path", root: nested },
      status: "disabled",
      removed: binding,
      fallback: null,
    });
  });

  it("removes only the pathless binding", async () => {
    const { project } = setup();
    const path = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: project },
      organizationId: "org_path",
    };
    const pathless = {
      provider: "codex" as const,
      project: { kind: "pathless" as const },
      organizationId: "org_pathless",
    };
    writeContextBinding(path);
    writeContextBinding(pathless);

    await runContextDisable(context({ provider: "codex", pathless: true, yes: true }));

    expect(readContextIntegrationConfig().bindings).toEqual([path]);
  });

  it("is idempotent when the current project is already disabled", async () => {
    const { nested } = setup();

    await runContextDisable(context({ provider: "codex", projectRoot: nested, yes: true }));

    expect(output.status).toHaveBeenCalledWith("Context", "Already disabled");
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 2, bindings: [] });
  });
});
