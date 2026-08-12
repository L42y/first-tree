import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentTemplateSchema } from "@first-tree/shared";
import { syncOfficialAgentTemplateCatalog } from "../src/services/agents/templates/official-catalog-publisher.js";

function parseApply(argv: readonly string[]): boolean {
  const unknown = argv.filter((arg) => arg !== "--apply" && arg !== "--");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`);
  return argv.includes("--apply");
}

async function main(): Promise<void> {
  const baseUrl = process.env.FIRST_TREE_SERVER_URL;
  const accessToken = process.env.FIRST_TREE_ACCESS_TOKEN;
  if (!baseUrl) throw new Error("FIRST_TREE_SERVER_URL is required.");
  if (!accessToken) throw new Error("FIRST_TREE_ACCESS_TOKEN is required.");

  const apply = parseApply(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const catalogPath = join(here, "../catalog/official-agent-templates.json");
  const source: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
  const definitions = createAgentTemplateSchema.array().length(3).parse(source);

  console.log(apply ? "APPLYING official Agent Template catalog" : "DRY RUN (pass --apply to publish)");
  console.log(`  server: ${new URL(baseUrl).origin}`);
  const results = await syncOfficialAgentTemplateCatalog({ baseUrl, accessToken, definitions, apply });
  for (const result of results) console.log(`  ${result.slug}: ${result.action}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
