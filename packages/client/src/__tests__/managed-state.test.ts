import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearManagedSkillsJournal,
  emptyManagedState,
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_STATE_REL,
  type ManagedSkillEntry,
  type ManagedSkillsJournal,
  type ManagedState,
  readManagedSkillsJournal,
  readManagedState,
  readManagedStateResult,
  writeManagedSkillsJournal,
  writeManagedState,
} from "../runtime/managed-state.js";

const DIGEST_A = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const DIGEST_B = `sha256:${"b".repeat(64)}` as `sha256:${string}`;

function entry(overrides: Partial<ManagedSkillEntry> = {}): ManagedSkillEntry {
  return {
    key: "core:first-tree-read",
    target: ".agents/skills/first-tree-read",
    requestedSlug: "first-tree-read",
    effectiveName: "first-tree-read",
    revision: "1.0.0",
    installedDigest: DIGEST_A,
    ...overrides,
  };
}

function state(skills: readonly ManagedSkillEntry[] = [entry()]): ManagedState {
  return {
    schemaVersion: 2,
    resourceConfigVersion: 7,
    updatedAt: new Date(0).toISOString(),
    skills,
  };
}

describe("managed-state v2", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "managed-state-v2-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("distinguishes missing, legacy, current, future, and invalid state", () => {
    expect(readManagedStateResult(workspace)).toEqual({ kind: "missing" });

    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "0.3.2",
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: ["first-tree-read", 42, "first-tree-write"],
      }),
    );
    expect(readManagedStateResult(workspace)).toEqual({
      kind: "legacy",
      state: {
        schemaVersion: 1,
        cliVersion: "0.3.2",
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: ["first-tree-read", "first-tree-write"],
      },
    });

    writeFileSync(join(workspace, MANAGED_STATE_REL), JSON.stringify({ schemaVersion: 99 }));
    expect(readManagedStateResult(workspace)).toEqual({ kind: "future", schemaVersion: 99 });

    writeFileSync(join(workspace, MANAGED_STATE_REL), "{not json");
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "invalid" });
    expect(readManagedState(workspace)).toBeNull();
  });

  it("round-trips normalized v2 entries atomically", () => {
    const persisted = writeManagedState(
      workspace,
      state([
        entry({
          key: "resource:resource-2",
          target: ".agents/skills/deploy",
          requestedSlug: "deploy",
          effectiveName: "deploy",
          revision: DIGEST_B,
          installedDigest: DIGEST_B,
        }),
        entry(),
      ]),
    );

    expect(persisted.updatedAt).not.toBe(new Date(0).toISOString());
    expect(persisted.skills.map((skill) => skill.key)).toEqual(["core:first-tree-read", "resource:resource-2"]);
    expect(readManagedState(workspace)).toEqual(persisted);
    expect(readFileSync(join(workspace, MANAGED_STATE_REL), "utf-8")).toMatch(/\n$/u);
    expect(readdirSync(join(workspace, ".first-tree-workspace")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed on unsafe paths, invalid digests, and conflicting target owners", () => {
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    const writeRaw = (skills: unknown[]): void => {
      writeFileSync(
        join(workspace, MANAGED_STATE_REL),
        JSON.stringify({
          schemaVersion: 2,
          resourceConfigVersion: 1,
          updatedAt: new Date().toISOString(),
          skills,
        }),
      );
    };

    writeRaw([{ ...entry(), target: "../../outside" }]);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "invalid" });

    writeRaw([{ ...entry(), installedDigest: "sha256:nope" }]);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "invalid" });

    writeRaw([{ ...entry(), effectiveName: "different-name" }]);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "invalid" });

    writeRaw([
      entry(),
      {
        ...entry({
          key: "resource:collision",
          requestedSlug: "collision",
          effectiveName: "first-tree-read",
          revision: DIGEST_B,
          installedDigest: DIGEST_B,
        }),
      },
    ]);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "invalid" });
  });

  it("rejects invalid state before writing and cleans atomic temp files after a write failure", () => {
    expect(() =>
      writeManagedState(workspace, {
        ...state(),
        skills: [entry({ target: "../escape" })],
      }),
    ).toThrow("invalid managed state");

    mkdirSync(join(workspace, MANAGED_STATE_REL), { recursive: true });
    expect(() => writeManagedState(workspace, emptyManagedState())).toThrow();
    expect(readdirSync(join(workspace, ".first-tree-workspace")).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("round-trips and clears a validated recovery journal", () => {
    const beforeState = writeManagedState(workspace, emptyManagedState(4));
    const afterState = state([entry()]);
    const journal: ManagedSkillsJournal = {
      schemaVersion: 1,
      operationId: "operation-1",
      operation: "install",
      phase: "target_installed",
      target: ".agents/skills/first-tree-read",
      staging: ".agents/skills/.first-tree-read.ft-1234.staging",
      backup: ".agents/skills/.first-tree-read.ft-1234.backup",
      expectedInstalledDigest: DIGEST_A,
      beforeState,
      afterState: { ...afterState, resourceConfigVersion: 4 },
    };

    writeManagedSkillsJournal(workspace, journal);
    expect(readManagedSkillsJournal(workspace)).toEqual({ kind: "current", journal });
    clearManagedSkillsJournal(workspace);
    expect(readManagedSkillsJournal(workspace)).toEqual({ kind: "missing" });
  });

  it("fails closed on malformed and future journals", () => {
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    writeFileSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL), JSON.stringify({ schemaVersion: 2 }));
    expect(readManagedSkillsJournal(workspace)).toEqual({ kind: "future", schemaVersion: 2 });

    writeFileSync(
      join(workspace, MANAGED_SKILLS_JOURNAL_REL),
      JSON.stringify({ schemaVersion: 1, operation: "install" }),
    );
    expect(readManagedSkillsJournal(workspace)).toMatchObject({ kind: "invalid" });
  });

  it("rejects journals whose temporary paths or state transition belong to another target", () => {
    const beforeState = writeManagedState(workspace, emptyManagedState(4));
    const validJournal: ManagedSkillsJournal = {
      schemaVersion: 1,
      operationId: "operation-1",
      operation: "install",
      phase: "target_installed",
      target: ".agents/skills/first-tree-read",
      staging: ".agents/skills/.first-tree-read.ft-1234.staging",
      backup: null,
      expectedInstalledDigest: DIGEST_A,
      beforeState,
      afterState: { ...state([entry()]), resourceConfigVersion: 4 },
    };

    writeFileSync(
      join(workspace, MANAGED_SKILLS_JOURNAL_REL),
      JSON.stringify({
        ...validJournal,
        staging: ".agents/skills/.first-tree-write.ft-1234.staging",
      }),
    );
    expect(readManagedSkillsJournal(workspace)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("does not belong to target"),
    });

    writeFileSync(
      join(workspace, MANAGED_SKILLS_JOURNAL_REL),
      JSON.stringify({
        ...validJournal,
        afterState: {
          ...validJournal.afterState,
          skills: [
            ...validJournal.afterState.skills,
            entry({
              key: "resource:other",
              target: ".agents/skills/other",
              requestedSlug: "other",
              effectiveName: "other",
              revision: DIGEST_B,
              installedDigest: DIGEST_B,
            }),
          ],
        },
      }),
    );
    expect(readManagedSkillsJournal(workspace)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("outside its target"),
    });
  });
});
