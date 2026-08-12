import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  SESSION_BRIEFINGS_DIR_REL,
  writeSessionBriefingFingerprint,
} from "../runtime/session-briefing-fingerprint.js";

const SESSION_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

/** Mirror of the module's storage key: sha256(sessionId) — the raw id must never be a path segment. */
function fingerprintFilePath(workspace: string, sessionId: string): string {
  const stem = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return join(workspace, SESSION_BRIEFINGS_DIR_REL, `${stem}.json`);
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ftt-briefing-fp-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("computeBriefingFingerprint", () => {
  it("is deterministic for identical content", () => {
    expect(computeBriefingFingerprint("hello briefing")).toBe(computeBriefingFingerprint("hello briefing"));
  });

  it("changes when the briefing content changes", () => {
    expect(computeBriefingFingerprint("v1")).not.toBe(computeBriefingFingerprint("v2"));
  });
});

describe("read/write round-trip", () => {
  it("returns null before any write (unknown baseline)", () => {
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });

  it("round-trips a written fingerprint", () => {
    const fp = computeBriefingFingerprint("the briefing");
    writeSessionBriefingFingerprint(workspace, SESSION_ID, fp);
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(fp);
  });

  it("isolates fingerprints per session id (shared agent home, no cross-session bleed)", () => {
    const other = "019d9a97-90b0-716b-8317-aaaaaaaaaaaa";
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("a"));
    writeSessionBriefingFingerprint(workspace, other, computeBriefingFingerprint("b"));
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(computeBriefingFingerprint("a"));
    expect(readSessionBriefingFingerprint(workspace, other)).toBe(computeBriefingFingerprint("b"));
  });

  it("overwrites a prior fingerprint for the same session", () => {
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("old"));
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("new"));
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(computeBriefingFingerprint("new"));
  });
});

describe("readSessionBriefingFingerprint resilience", () => {
  it("returns null on malformed JSON", () => {
    writeSessionBriefingFingerprint(workspace, SESSION_ID, "seed-so-dir-exists");
    writeFileSync(fingerprintFilePath(workspace, SESSION_ID), "{not json", "utf-8");
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });

  it("returns null for an unknown schema version (future writer)", () => {
    writeSessionBriefingFingerprint(workspace, SESSION_ID, "seed");
    writeFileSync(
      fingerprintFilePath(workspace, SESSION_ID),
      JSON.stringify({ schemaVersion: 2, fingerprint: "x" }),
      "utf-8",
    );
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });
});

describe("path containment (opaque provider session ids)", () => {
  // Ids satisfying each provider's loose id grammar but containing path
  // segments: OpenCode only requires a `ses` prefix, and persisted/resumed
  // ids are accepted as arbitrary non-empty strings.
  const traversalId = "ses/../../../.first-tree/workspace";
  const backslashId = "..\\..\\evil";
  const hostileIds = [traversalId, "../../package", backslashId, "ses_/absolute/looking/path"];

  it("round-trips hostile opaque ids without leaving the runtime dir", () => {
    for (const [index, id] of hostileIds.entries()) {
      const fp = computeBriefingFingerprint(`briefing-${index}`);
      writeSessionBriefingFingerprint(workspace, id, fp);
      expect(readSessionBriefingFingerprint(workspace, id)).toBe(fp);
    }
  });

  it("keeps hostile-id fingerprints isolated per id (no sanitization collisions)", () => {
    writeSessionBriefingFingerprint(workspace, traversalId, computeBriefingFingerprint("a"));
    writeSessionBriefingFingerprint(workspace, backslashId, computeBriefingFingerprint("b"));
    expect(readSessionBriefingFingerprint(workspace, traversalId)).toBe(computeBriefingFingerprint("a"));
    expect(readSessionBriefingFingerprint(workspace, backslashId)).toBe(computeBriefingFingerprint("b"));
  });

  it("writes every artifact inside SESSION_BRIEFINGS_DIR_REL and never touches other workspace files", () => {
    const workspaceJson = join(workspace, ".first-tree", "workspace.json");
    mkdirSync(join(workspace, ".first-tree"), { recursive: true });
    writeFileSync(workspaceJson, '{"sentinel":true}', "utf-8");
    for (const id of hostileIds) {
      writeSessionBriefingFingerprint(workspace, id, computeBriefingFingerprint(id));
    }
    const dir = join(workspace, SESSION_BRIEFINGS_DIR_REL);
    const entries = readdirSync(dir);
    expect(entries.length).toBe(hostileIds.length);
    for (const entry of entries) {
      expect(entry).toMatch(/^[0-9a-f]{64}\.json$/);
    }
    // nothing escaped: no files directly under the runtime dir or workspace root
    expect(readdirSync(join(workspace, ".first-tree-workspace"))).toEqual(["session-briefings"]);
    expect(readFileSync(workspaceJson, "utf-8")).toBe('{"sentinel":true}');
  });
});

describe("buildBriefingUpdateNotice", () => {
  it("wraps a system-reminder, names the CLAUDE.md path, and flags the comms-contract change", () => {
    const notice = buildBriefingUpdateNotice("/home/agent/CLAUDE.md");
    expect(notice.startsWith("<system-reminder>")).toBe(true);
    expect(notice.trimEnd().endsWith("</system-reminder>")).toBe(true);
    expect(notice).toContain("/home/agent/CLAUDE.md");
    expect(notice).toContain("re-read");
    expect(notice).toContain("reply to a human");
  });
});
