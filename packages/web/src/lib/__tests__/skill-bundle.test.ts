import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { preparePastedSkill, prepareSkillFile, prepareSkillFolder } from "../skill-bundle.js";

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe("Skill bundle preparation", () => {
  it("wraps pasted markdown as root SKILL.md", async () => {
    const prepared = preparePastedSkill("---\nname: demo\n---\nBody");
    const files = await unzip(prepared.blob);

    expect(prepared.filename).toBe("skill.zip");
    expect(Object.keys(files)).toEqual(["SKILL.md"]);
    expect(strFromU8(files["SKILL.md"] ?? new Uint8Array())).toContain("name: demo");
  });

  it("passes ZIP uploads through and normalizes a markdown upload", async () => {
    const markdown = new File(["skill body"], "custom.md", { type: "text/markdown" });
    const prepared = await prepareSkillFile(markdown);
    const files = await unzip(prepared.blob);
    expect(strFromU8(files["SKILL.md"] ?? new Uint8Array())).toBe("skill body");

    const zipped = new File([prepared.blob], "custom.zip", { type: "application/zip" });
    const passthrough = await prepareSkillFile(zipped);
    expect(passthrough.filename).toBe("custom.zip");
    expect(Object.keys(await unzip(passthrough.blob))).toEqual(["SKILL.md"]);
  });

  it("preserves folder-relative paths", async () => {
    const skill = new File(["skill"], "SKILL.md");
    const script = new File(["echo ok"], "run.sh");
    Object.defineProperty(skill, "webkitRelativePath", { value: "demo/SKILL.md" });
    Object.defineProperty(script, "webkitRelativePath", { value: "demo/scripts/run.sh" });

    const prepared = await prepareSkillFolder([skill, script]);
    expect(Object.keys(await unzip(prepared.blob)).sort()).toEqual(["demo/SKILL.md", "demo/scripts/run.sh"]);
    expect(prepared.filename).toBe("demo.zip");
  });
});
