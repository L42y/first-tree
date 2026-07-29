import { strToU8, zipSync } from "fflate";

export type PreparedSkillBundle = {
  blob: Blob;
  filename: string;
  summary: string;
};

export function preparePastedSkill(markdown: string): PreparedSkillBundle {
  return zipFiles({ "SKILL.md": strToU8(markdown) }, "Pasted SKILL.md");
}

export async function prepareSkillFile(file: File): Promise<PreparedSkillBundle> {
  if (file.name.toLocaleLowerCase("en-US").endsWith(".zip")) {
    return {
      blob: new Blob([file], { type: "application/zip" }),
      filename: file.name,
      summary: file.name,
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return zipFiles({ "SKILL.md": bytes }, file.name);
}

export async function prepareSkillFolder(files: FileList | readonly File[]): Promise<PreparedSkillBundle> {
  const selected = Array.from(files);
  if (selected.length === 0) throw new Error("Choose a Skill folder first");
  const entries: Record<string, Uint8Array> = {};
  await Promise.all(
    selected.map(async (file) => {
      const relative = file.webkitRelativePath || file.name;
      entries[relative] = new Uint8Array(await file.arrayBuffer());
    }),
  );
  const root = selected[0]?.webkitRelativePath.split("/")[0] || "skill";
  return zipFiles(entries, `${root}/ (${selected.length} files)`, `${root}.zip`);
}

function zipFiles(entries: Record<string, Uint8Array>, summary: string, filename = "skill.zip"): PreparedSkillBundle {
  const bytes = zipSync(entries, { level: 6 });
  return {
    blob: new Blob([bytes], { type: "application/zip" }),
    filename,
    summary,
  };
}
