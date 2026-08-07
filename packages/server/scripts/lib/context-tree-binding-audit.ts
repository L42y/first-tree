import { contextTreeRepoOwnershipIdentity } from "../../src/services/org-settings.js";

/**
 * Pure partitioning behind the shared-Context-Tree-repo audit. Keeping it in
 * `scripts/lib` lets the audit runner supply rows and print them while this
 * logic remains independently testable.
 */

export type BindingRow = {
  organization_id: string;
  display_name: string | null;
  repo: string | null;
  instance_origin: string | null;
};

export type SharedRepo = {
  identity: string;
  teams: Array<{ organizationId: string; displayName: string; repo: string }>;
};

export type UnresolvedBinding = { organizationId: string; displayName: string; repo: string };

export type AuditResult = { shared: SharedRepo[]; unresolved: UnresolvedBinding[] };

/**
 * Split bindings into repositories more than one team holds, and rows whose
 * forge cannot be established.
 *
 * Unresolved rows are reported rather than dropped. Legacy and hand-edited
 * bindings may keep a repo with no provider or no matching connection, and
 * those are exactly the rows a remediation audit exists to surface — silently
 * skipping them would let two affected teams go unlisted while the operator
 * reads "no sharing" and stops looking.
 */
export function auditBindings(rows: BindingRow[]): AuditResult {
  const byIdentity = new Map<string, SharedRepo>();
  const unresolved: UnresolvedBinding[] = [];
  for (const row of rows) {
    if (!row.repo) continue;
    const team = {
      organizationId: row.organization_id,
      displayName: row.display_name ?? "",
      repo: row.repo,
    };
    const identity = contextTreeRepoOwnershipIdentity(row.repo, row.instance_origin);
    if (!identity) {
      unresolved.push(team);
      continue;
    }
    const entry = byIdentity.get(identity) ?? { identity, teams: [] };
    entry.teams.push(team);
    byIdentity.set(identity, entry);
  }
  return {
    shared: [...byIdentity.values()]
      .filter((entry) => entry.teams.length > 1)
      .sort((a, b) => b.teams.length - a.teams.length),
    unresolved,
  };
}
