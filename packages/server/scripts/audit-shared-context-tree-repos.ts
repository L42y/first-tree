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
 * Each row resolves through its own team's GitLab connection origin, so an SSH
 * binding and an HTTPS binding on one self-managed forge group together while
 * two forges on one host stay apart. A row whose forge cannot be classified has
 * no establishable authority and is skipped rather than guessed at.
 *
 * Read-only: it issues one SELECT and writes nothing. Repo URLs are printed so
 * an operator can act on them, so treat the output as customer data.
 *
 * Run: DATABASE_URL=... pnpm --filter @first-tree/server tsx scripts/audit-shared-context-tree-repos.ts
 */

import { sql } from "drizzle-orm";
import { connectDatabase } from "../src/db/connection.js";
import { contextTreeRepoOwnershipIdentity } from "../src/services/org-settings.js";

type BindingRow = {
  organization_id: string;
  display_name: string | null;
  repo: string | null;
  provider: string | null;
  instance_origin: string | null;
};

type SharedRepo = {
  identity: string;
  teams: Array<{ organizationId: string; displayName: string; repo: string }>;
};

function groupBySharedRepo(rows: BindingRow[]): SharedRepo[] {
  const byIdentity = new Map<string, SharedRepo>();
  for (const row of rows) {
    const provider = row.provider === "github" || row.provider === "gitlab" ? row.provider : undefined;
    const identity = contextTreeRepoOwnershipIdentity(row.repo, provider, row.instance_origin);
    if (!identity || !row.repo) continue;
    const entry = byIdentity.get(identity) ?? { identity, teams: [] };
    entry.teams.push({
      organizationId: row.organization_id,
      displayName: row.display_name ?? "",
      repo: row.repo,
    });
    byIdentity.set(identity, entry);
  }
  return [...byIdentity.values()]
    .filter((entry) => entry.teams.length > 1)
    .sort((a, b) => b.teams.length - a.teams.length);
}

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
        s.value->>'provider'  AS provider,
        g.instance_origin     AS instance_origin
      FROM organization_settings s
      JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN gitlab_connections g ON g.organization_id = s.organization_id
      WHERE s.namespace = 'context_tree'
        AND s.value->>'repo' IS NOT NULL
      ORDER BY s.organization_id
    `);

    const shared = groupBySharedRepo([...rows]);
    if (shared.length === 0) {
      console.log("No Context Tree repo is bound to more than one team.");
      return;
    }

    console.log(`${shared.length} Context Tree repo(s) bound to more than one team:\n`);
    for (const entry of shared) {
      console.log(`${entry.identity}  (${entry.teams.length} teams)`);
      for (const team of entry.teams) {
        console.log(`  - ${team.organizationId}  ${team.displayName}  ${team.repo}`);
      }
      console.log("");
    }
    console.log(
      "Each of these needs an owner decision: which team keeps the tree, and where the others' context goes.",
    );
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
