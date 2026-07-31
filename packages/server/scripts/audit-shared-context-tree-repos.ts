/**
 * Report Context Tree repos that more than one team is bound to.
 *
 * A Context Tree repo belongs to exactly one team. Provisioning used to derive
 * the repo name from the team display name alone, and display names are
 * deliberately not unique — every name without an ASCII alphanumeric slugified
 * to the same `"team"` fallback. Two teams under one GitHub account therefore
 * derived one repo name, and the adopt-on-conflict step handed the second team
 * the first team's tree. Deriving the name per organization stops new
 * collisions; it does not unpick bindings already written, which is what this
 * reports.
 *
 * Read-only: it issues one SELECT and writes nothing. Repo URLs are printed so
 * an operator can act on them, so treat the output as customer data.
 *
 * Run: DATABASE_URL=... pnpm --filter @first-tree/server tsx scripts/audit-shared-context-tree-repos.ts
 */

import { sql } from "drizzle-orm";
import { connectDatabase } from "../src/db/connection.js";

type SharedRepoRow = {
  repo: string;
  org_count: number;
  organization_ids: string[];
  display_names: string[];
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required.");
    process.exitCode = 1;
    return;
  }

  const db = connectDatabase(url);

  const rows = await db.execute<SharedRepoRow>(sql`
    SELECT
      lower(s.value->>'repo')                       AS repo,
      count(*)::int                                 AS org_count,
      array_agg(s.organization_id ORDER BY s.organization_id) AS organization_ids,
      array_agg(o.display_name ORDER BY s.organization_id)    AS display_names
    FROM organization_settings s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.namespace = 'context_tree'
      AND s.value->>'repo' IS NOT NULL
    GROUP BY lower(s.value->>'repo')
    HAVING count(*) > 1
    ORDER BY count(*) DESC
  `);

  if (rows.length === 0) {
    console.log("No Context Tree repo is bound to more than one team.");
    await db.end();
    return;
  }

  console.log(`${rows.length} Context Tree repo(s) bound to more than one team:\n`);
  for (const row of rows) {
    console.log(`${row.repo}  (${row.org_count} teams)`);
    row.organization_ids.forEach((orgId, i) => {
      console.log(`  - ${orgId}  ${row.display_names[i] ?? ""}`);
    });
    console.log("");
  }
  console.log("Each of these needs an owner decision: which team keeps the tree, and where the others' context goes.");
  await db.end();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
