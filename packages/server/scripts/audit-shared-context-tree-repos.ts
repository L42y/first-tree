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
 * Grouping uses the same repository identity the binding guard decides on, not
 * URL text: the binding contract accepts HTTPS, `ssh://`, and scp-like SSH
 * spellings with an optional `.git`, so two teams can share one repository
 * through two spellings and a text grouping would report them as unrelated.
 * An HTTP(S) row carries its own web origin; an SSH row resolves through its
 * own team's GitLab connection, so an SSH binding and an HTTPS binding on one
 * self-managed forge group together while two forges on one host stay apart. An
 * SSH row whose team has no connection has no establishable origin and is
 * skipped rather than guessed at.
 *
 * Read-only: it issues one SELECT and writes nothing. Repo URLs are printed so
 * an operator can act on them, so treat the output as customer data.
 *
 * Run: DATABASE_URL=... pnpm --filter @first-tree/server tsx scripts/audit-shared-context-tree-repos.ts
 */

import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { connectDatabase } from "../src/db/connection.js";
import { auditBindings, type BindingRow } from "./lib/context-tree-binding-audit.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required.");
    process.exitCode = 1;
    return;
  }

  const db = connectDatabase(url);
  try {
    const rows = await db.execute<BindingRow>(sql`
      SELECT
        s.organization_id     AS organization_id,
        o.display_name        AS display_name,
        s.value->>'repo'      AS repo,
        g.instance_origin     AS instance_origin
      FROM organization_settings s
      JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN gitlab_connections g ON g.organization_id = s.organization_id
      WHERE s.namespace = 'context_tree'
        AND s.value->>'repo' IS NOT NULL
      ORDER BY s.organization_id
    `);

    const { shared, unresolved } = auditBindings([...rows]);

    for (const entry of shared) {
      console.log(`${entry.identity}  (${entry.teams.length} teams)`);
      for (const team of entry.teams) {
        console.log(`  - ${team.organizationId}  ${team.displayName}  ${team.repo}`);
      }
      console.log("");
    }
    if (shared.length > 0) {
      console.log(`${shared.length} Context Tree repo(s) bound to more than one team.`);
      console.log("Each needs an owner decision: which team keeps the tree, and where the others' context goes.\n");
    }

    if (unresolved.length > 0) {
      console.log(`${unresolved.length} binding(s) whose forge could not be established:\n`);
      for (const team of unresolved) {
        console.log(`  - ${team.organizationId}  ${team.displayName}  ${team.repo}`);
      }
      console.log("\nThese were not compared against anything, so this run cannot tell you whether they are shared.");
      console.log("Resolve them — connect the owning team's forge, or correct the binding — and run again.");
    }

    if (shared.length === 0 && unresolved.length === 0) {
      console.log("No Context Tree repo is bound to more than one team, and every binding resolved.");
      return;
    }

    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

// Importing this module for its pure helpers must not open a database
// connection, so only a direct run performs the audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
