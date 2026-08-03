import { describe, expect, it } from "vitest";
import { auditBindings, type BindingRow } from "../services/context-tree-binding-audit.js";

function row(organizationId: string, repo: string, instanceOrigin: string | null = null): BindingRow {
  return {
    organization_id: organizationId,
    display_name: `Team ${organizationId}`,
    repo,
    instance_origin: instanceOrigin,
  };
}

describe("audit-shared-context-tree-repos", () => {
  it("groups transport spellings of one repository together", () => {
    const origin = "https://git.internal:8443";
    const { shared, unresolved } = auditBindings([
      row("org-https", "https://git.internal:8443/group/tree.git", origin),
      row("org-ssh", "ssh://git@git.internal:2222/group/tree.git", origin),
      row("org-scp", "git@git.internal:group/tree.git", origin),
    ]);

    expect(unresolved).toEqual([]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.teams.map((team) => team.organizationId).sort()).toEqual(["org-https", "org-scp", "org-ssh"]);
  });

  it("keeps two self-managed instances on one host apart", () => {
    const { shared } = auditBindings([
      row("org-8443", "https://git.internal:8443/group/tree.git"),
      row("org-9443", "https://git.internal:9443/group/tree.git"),
    ]);

    expect(shared).toEqual([]);
  });

  it("reports a binding whose forge cannot be established instead of dropping it", () => {
    // A legacy or hand-edited row may keep a repo with no provider and no
    // matching connection. Skipping it silently would let two affected teams go
    // unlisted while the operator reads a clean result.
    const { shared, unresolved } = auditBindings([
      row("org-legacy", "git@git.internal:group/tree.git"),
      row("org-other", "git@git.internal:group/tree.git"),
    ]);

    expect(shared).toEqual([]);
    expect(unresolved.map((team) => team.organizationId)).toEqual(["org-legacy", "org-other"]);
  });

  it("separates unresolved rows from a genuine sharing report", () => {
    const { shared, unresolved } = auditBindings([
      row("org-a", "https://github.com/acme/tree.git"),
      row("org-b", "git@github.com:acme/tree.git"),
      row("org-legacy", "git@git.internal:group/tree.git"),
    ]);

    expect(shared).toHaveLength(1);
    expect(shared[0]?.teams.map((team) => team.organizationId).sort()).toEqual(["org-a", "org-b"]);
    expect(unresolved.map((team) => team.organizationId)).toEqual(["org-legacy"]);
  });
});
