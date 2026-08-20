import type { EffectiveResourceRow, SkillDescriptor } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  buildSlashInsert,
  detectSlashTrigger,
  mergeSlashSkills,
  rankSlashCommands,
  resolveMentionContext,
  type SlashCommandItem,
  type SlashSkillInfo,
  type SlashSystemCommand,
  teamSkillRowsToSlashSkills,
} from "../slash-command-autocomplete.js";

function sysCmd(name: string, description = ""): SlashSystemCommand {
  return { kind: "system", name, description };
}

function skillItem(name: string, namespace?: string): SlashCommandItem {
  const skill: SkillDescriptor = {
    name,
    description: `desc ${name}`,
    source: "user",
    ...(namespace ? { namespace } : {}),
  };
  return { kind: "skill", skill, agentId: "agt-1", agentDisplayName: "Agent" };
}

describe("detectSlashTrigger", () => {
  it("detects `/` at the very start of the buffer", () => {
    expect(detectSlashTrigger("/re", 3)).toEqual({ triggerIndex: 0, query: "re" });
  });

  it("detects `/` after leading whitespace (tolerates indented composers)", () => {
    expect(detectSlashTrigger("  /he", 5)).toEqual({ triggerIndex: 2, query: "he" });
  });

  it("does NOT trigger on mid-line `/` — slash commands are composer-mode", () => {
    expect(detectSlashTrigger("hi /help", 8)).toBeNull();
  });

  it("does NOT trigger after a `@mention` followed by `/` — slash must be first non-ws char", () => {
    expect(detectSlashTrigger("@reviewer /re", 13)).toBeNull();
  });

  it("returns empty query for a bare `/`", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ triggerIndex: 0, query: "" });
  });

  it("rejects non-name chars in the query (closes the trigger)", () => {
    expect(detectSlashTrigger("/foo bar", 8)).toBeNull();
  });

  it("accepts namespaced commands (`/plugin:name`)", () => {
    expect(detectSlashTrigger("/hyperframes:gsap", 17)).toEqual({ triggerIndex: 0, query: "hyperframes:gsap" });
  });
});

describe("resolveMentionContext", () => {
  const participants = [
    { agentId: "a", name: "alice", displayName: "Alice" },
    { agentId: "b", name: "bob", displayName: "Bob" },
  ];

  it("picks the most recent mention before the cursor", () => {
    const got = resolveMentionContext("@alice please. @bob /", 21, participants);
    expect(got).toEqual({ agentId: "b", displayName: "Bob" });
  });

  it("ignores mentions after the cursor", () => {
    const got = resolveMentionContext("@alice /  @bob", 8, participants);
    expect(got).toEqual({ agentId: "a", displayName: "Alice" });
  });

  it("returns null when no @<name> resolves", () => {
    expect(resolveMentionContext("hi /", 4, participants)).toBeNull();
    expect(resolveMentionContext("@unknown /", 10, participants)).toBeNull();
  });

  it("falls back to display name when participant has no friendly label", () => {
    const got = resolveMentionContext("@bob /", 6, [{ agentId: "b", name: "bob", displayName: null }]);
    expect(got).toEqual({ agentId: "b", displayName: "bob" });
  });
});

describe("rankSlashCommands", () => {
  const items: SlashCommandItem[] = [
    sysCmd("help"),
    sysCmd("clear"),
    skillItem("review"),
    skillItem("ship"),
    skillItem("gsap", "hyperframes"),
  ];

  it("filters by case-insensitive prefix first", () => {
    const r = rankSlashCommands(items, "he");
    expect(r.map((i) => (i.kind === "system" ? i.name : i.skill.name))).toEqual(["help"]);
  });

  it("prefers prefix matches over substring matches", () => {
    const r = rankSlashCommands([sysCmd("score"), ...items], "re");
    // `score` is a substring match ("re" inside "sCORe" — index 3); `review`
    // is a prefix match. Prefix wins.
    expect(r.map((i) => (i.kind === "system" ? i.name : i.skill.name))).toEqual(["review", "score"]);
  });

  it("system commands win ties with the same score", () => {
    // Both `/clear` (system) and `/cli` (hypothetical) start with `cl`;
    // here we just check the kind-tiebreaker via empty query.
    const r = rankSlashCommands(items, "");
    expect(r.filter((i) => i.kind === "system").length).toBe(2);
    // System block sorts before skills in ties.
    expect(r[0]?.kind).toBe("system");
  });

  it("matches namespaced commands via `namespace:name` key", () => {
    const r = rankSlashCommands(items, "hyperframes:g");
    expect(r.map((i) => (i.kind === "skill" ? i.skill.name : i.name))).toEqual(["gsap"]);
  });
});

describe("buildSlashInsert", () => {
  it("clears the textarea for system commands so they are not sent literally", () => {
    const insert = buildSlashInsert("/he", { triggerIndex: 0, query: "he" }, 3, sysCmd("help"));
    expect(insert).toEqual({ text: "", cursor: 0, kind: "system" });
  });

  it("replaces `/<query>` with `/<name> ` for a skill so the user can type args", () => {
    const insert = buildSlashInsert("/re", { triggerIndex: 0, query: "re" }, 3, skillItem("review"));
    expect(insert.text).toBe("/review ");
    expect(insert.cursor).toBe("/review ".length);
    expect(insert.kind).toBe("skill");
  });

  it("does not double-space when a space already follows the trigger", () => {
    const insert = buildSlashInsert("/re foo", { triggerIndex: 0, query: "re" }, 3, skillItem("review"));
    expect(insert.text).toBe("/review foo");
  });

  it("emits the namespaced literal for plugin skills", () => {
    const insert = buildSlashInsert("/hy", { triggerIndex: 0, query: "hy" }, 3, skillItem("gsap", "hyperframes"));
    expect(insert.text).toBe("/hyperframes:gsap ");
  });
});

let teamRowSeq = 0;
function teamSkillRow(overrides: {
  mode?: EffectiveResourceRow["mode"];
  resourceId?: string | null;
  payload?: unknown;
}): EffectiveResourceRow {
  return {
    id: "row-1",
    bindingId: null,
    resourceId: overrides.resourceId === undefined ? `res-${++teamRowSeq}` : overrides.resourceId,
    replacesResourceId: null,
    type: "skill",
    name: "Team Skill",
    scope: "team",
    source: "team_recommended",
    mode: overrides.mode ?? "enabled",
    defaultEnabled: "recommended",
    payload:
      overrides.payload !== undefined
        ? overrides.payload
        : { name: "Code Review", description: "Review a change end to end.", body: "skill body" },
    repo: null,
    promptBody: null,
    unavailableReason: null,
    originTemplateId: null,
    order: 0,
  };
}

describe("teamSkillRowsToSlashSkills", () => {
  it("projects an enabled Team Skill under its portable materializer slug", () => {
    const got = teamSkillRowsToSlashSkills([teamSkillRow({})]);
    expect(got).toEqual([{ name: "code-review", description: "Review a change end to end." }]);
  });

  it("drops the payload namespace — the runtime projection installs the plain slug", () => {
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({
        payload: { name: "Code Review", namespace: "Tools", description: "d", body: "b" },
      }),
    ]);
    expect(got).toEqual([{ name: "code-review", description: "d" }]);
  });

  it("excludes disabled, replaced, and unavailable rows", () => {
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({ mode: "disabled" }),
      teamSkillRow({ mode: "replaced" }),
      teamSkillRow({ mode: "unavailable" }),
    ]);
    expect(got).toEqual([]);
  });

  it("skips malformed payloads without dropping the valid rows", () => {
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({ payload: null }),
      teamSkillRow({ payload: { name: "No Body" } }),
      teamSkillRow({ payload: { name: "", description: "d", body: "b" } }),
      teamSkillRow({ payload: { name: "Good Skill", description: "d", body: "b" } }),
    ]);
    expect(got).toEqual([{ name: "good-skill", description: "d" }]);
  });

  it("skips names that do not produce a portable, triggerable slug", () => {
    const payloadNamed = (name: string) => ({ name, description: "d", body: "b" });
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({ payload: payloadNamed("!!!") }),
      teamSkillRow({ payload: payloadNamed("con") }),
      teamSkillRow({ payload: payloadNamed("first-tree-qa") }),
      teamSkillRow({ payload: payloadNamed("a/b") }),
      teamSkillRow({ payload: payloadNamed("Ship It") }),
    ]);
    expect(got).toEqual([{ name: "ship-it", description: "d" }]);
  });
});

describe("mergeSlashSkills", () => {
  const runtime = (name: string, namespace?: string): SlashSkillInfo => ({
    name,
    description: `runtime ${name}`,
    ...(namespace ? { namespace } : {}),
  });
  const team = (name: string): SlashSkillInfo => ({ name, description: `team ${name}` });

  it("prefers the Team row on a case-insensitive literal match — the menu winner must match the executor", () => {
    // The Client's command registry claims a Team Skill's base slug, so
    // the same folded literal resolves to the Team Skill at execution
    // time; the menu must not show the runtime row for it.
    const got = mergeSlashSkills([runtime("Ship")], [team("ship")]);
    expect(got).toEqual([{ name: "ship", description: "team ship" }]);
  });

  it("dedupes namespaced literals case-insensitively, team first", () => {
    const got = mergeSlashSkills(
      [runtime("gsap", "HyperFrames")],
      [{ name: "gsap", namespace: "hyperframes", description: "team gsap" }],
    );
    expect(got).toEqual([{ name: "gsap", namespace: "hyperframes", description: "team gsap" }]);
  });

  it("keeps distinct commands from both sources, sorted by label key", () => {
    const got = mergeSlashSkills([runtime("ship")], [team("code-review"), team("audit")]);
    expect(got.map((s) => s.name)).toEqual(["audit", "code-review", "ship"]);
  });

  it("degrades to whichever source is still available when the other is empty", () => {
    expect(mergeSlashSkills([], [team("audit")])).toEqual([{ name: "audit", description: "team audit" }]);
    expect(mergeSlashSkills([runtime("ship")], [])).toEqual([{ name: "ship", description: "runtime ship" }]);
    expect(mergeSlashSkills([], [])).toEqual([]);
  });
});

describe("detectSlashTrigger — mention-prefixed composer mode", () => {
  it("triggers after a committed mention token + whitespace (`@Nova /re`)", () => {
    const got = detectSlashTrigger("@Nova /re", 9, [{ start: 0, end: 5 }]);
    expect(got).toEqual({ triggerIndex: 6, query: "re" });
  });

  it("handles display names containing spaces via the token span, not text parsing", () => {
    const got = detectSlashTrigger("@Design Critique /re", 20, [{ start: 0, end: 16 }]);
    expect(got).toEqual({ triggerIndex: 17, query: "re" });
  });

  it("accepts several committed tokens before the slash", () => {
    const got = detectSlashTrigger("@Nova @Design Critique /re", 26, [
      { start: 0, end: 5 },
      { start: 6, end: 22 },
    ]);
    expect(got).toEqual({ triggerIndex: 23, query: "re" });
  });

  it("accepts a slash flush against the token end", () => {
    const got = detectSlashTrigger("@Nova/re", 8, [{ start: 0, end: 5 }]);
    expect(got).toEqual({ triggerIndex: 5, query: "re" });
  });

  it("rejects plain prose between the mention and the slash", () => {
    expect(detectSlashTrigger("@Nova hi /re", 12, [{ start: 0, end: 5 }])).toBeNull();
  });

  it("rejects a literally-typed `@name` that was never committed as a token", () => {
    expect(detectSlashTrigger("@nova /re", 9)).toBeNull();
  });

  it("rejects a slash inside a token span", () => {
    expect(detectSlashTrigger("@Nov/re", 7, [{ start: 0, end: 5 }])).toBeNull();
  });

  it("rejects prose before the mention token", () => {
    expect(detectSlashTrigger("hi @Nova /re", 12, [{ start: 3, end: 8 }])).toBeNull();
  });

  it("bare mode still wins when the slash is the first non-whitespace char", () => {
    expect(detectSlashTrigger("/re", 3, [{ start: 5, end: 10 }])).toEqual({ triggerIndex: 0, query: "re" });
  });
});

describe("buildSlashInsert — mention-prefixed drafts", () => {
  it("keeps the mention prefix when a system command clears the draft", () => {
    const insert = buildSlashInsert("@Nova /cle", { triggerIndex: 6, query: "cle" }, 10, sysCmd("clear"));
    expect(insert).toEqual({ text: "@Nova ", cursor: 6, kind: "system" });
  });

  it("inserts the skill literal after the mention prefix", () => {
    const insert = buildSlashInsert("@Nova /re", { triggerIndex: 6, query: "re" }, 9, skillItem("review"));
    expect(insert.text).toBe("@Nova /review ");
    expect(insert.cursor).toBe("@Nova /review ".length);
    expect(insert.kind).toBe("skill");
  });
});

describe("teamSkillRowsToSlashSkills — fail-closed ambiguous targets", () => {
  const payloadNamed = (name: string, description: string) => ({ name, description, body: "b" });

  it("skips a normalized-slug collision group entirely and keeps the other skills", () => {
    // `foo_bar` and `foo-bar` both normalize to `foo-bar`; the
    // materializer's collision suffix depends on install history the Web
    // cannot see, so neither row may surface. Unrelated skills survive.
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({ resourceId: "res-b", payload: payloadNamed("foo-bar", "second") }),
      teamSkillRow({ resourceId: "res-a", payload: payloadNamed("foo_bar", "first") }),
      teamSkillRow({ resourceId: "res-c", payload: payloadNamed("Solo Skill", "solo") }),
    ]);
    expect(got).toEqual([{ name: "solo-skill", description: "solo" }]);
  });

  it("skips the collision group regardless of API row order — never picks a winner", () => {
    const forward = teamSkillRowsToSlashSkills([
      teamSkillRow({ resourceId: "res-a", payload: payloadNamed("foo_bar", "first") }),
      teamSkillRow({ resourceId: "res-b", payload: payloadNamed("foo-bar", "second") }),
    ]);
    const reversed = teamSkillRowsToSlashSkills([
      teamSkillRow({ resourceId: "res-b", payload: payloadNamed("foo-bar", "second") }),
      teamSkillRow({ resourceId: "res-a", payload: payloadNamed("foo_bar", "first") }),
    ]);
    expect(forward).toEqual([]);
    expect(reversed).toEqual([]);
  });

  it("rejects a duplicate resourceId group like the materializer does", () => {
    const got = teamSkillRowsToSlashSkills([
      teamSkillRow({ resourceId: "res-dup", payload: payloadNamed("Alpha", "a") }),
      teamSkillRow({ resourceId: "res-dup", payload: payloadNamed("Beta", "b") }),
      teamSkillRow({ resourceId: "res-ok", payload: payloadNamed("Gamma", "g") }),
    ]);
    expect(got).toEqual([{ name: "gamma", description: "g" }]);
  });

  it("skips rows without a resourceId — they never reach the materializer", () => {
    const got = teamSkillRowsToSlashSkills([teamSkillRow({ resourceId: null, payload: payloadNamed("Ghost", "g") })]);
    expect(got).toEqual([]);
  });
});
