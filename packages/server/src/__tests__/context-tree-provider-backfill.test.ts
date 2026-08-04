import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contextTreeActiveBindingSchema,
  orgContextTreeStorageSchema,
  resolveContextTreeProvider,
} from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { createOrganization } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const migrationSql = readFileSync(
  join(import.meta.dirname, "../../drizzle/0092_backfill_context_tree_providers.sql"),
  "utf8",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Context Tree provider backfill migration", () => {
  const getApp = useTestApp();

  it("backfills only resolver-confirmed legacy bindings and is idempotent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const oldUpdatedAt = new Date("2024-01-02T03:04:05.000Z");
    const fixtures = [
      { label: "github https", value: { repo: "https://github.com/acme/tree.git", branch: "main", extra: true } },
      { label: "github ssh", value: { repo: "ssh://git@github.com:2222/acme/tree.git", branch: "main" } },
      { label: "github scp", value: { repo: "git@github.com:acme/tree.git", branch: "main" } },
      { label: "github web port", value: { repo: "https://github.com:8443/acme/tree.git", branch: "main" } },
      { label: "github invalid ssh port", value: { repo: "ssh://git@github.com:99999/acme/tree.git", branch: "main" } },
      { label: "github normalized empty path", value: { repo: "https://github.com/./", branch: "main" } },
      { label: "github ambiguous scp port", value: { repo: "git@github.com:1234/acme/tree.git", branch: "main" } },
      { label: "incomplete github path", value: { repo: "https://github.com//", branch: "main" } },
      { label: "null branch", value: { repo: "https://github.com/acme/null-branch.git", branch: null } },
      { label: "invalid branch", value: { repo: "https://github.com/acme/invalid-branch.git", branch: "bad..branch" } },
      {
        label: "gitlab https",
        value: { repo: "https://gitlab.internal:8443/group/tree.git", branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      },
      {
        label: "gitlab ssh",
        value: { repo: "ssh://git@gitlab.internal:2222/group/tree.git", branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      },
      {
        label: "gitlab scp",
        value: { repo: "git@gitlab.internal:group/tree.git", branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      },
      {
        label: "gitlab mismatched port",
        value: { repo: "https://gitlab.internal:9443/group/tree.git", branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      },
      {
        label: "gitlab invalid ssh port",
        value: { repo: "ssh://git@gitlab.internal:65536/group/tree.git", branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      },
      {
        label: "gitlab connection missing",
        value: { repo: "https://gitlab.internal/group/tree.git", branch: "main" },
      },
      { label: "unknown forge", value: { repo: "git@forge.internal:group/tree.git", branch: "main" } },
      {
        label: "existing provider",
        value: { provider: "github", repo: "https://github.com/acme/existing.git", branch: "main" },
      },
      { label: "non-string repo", value: { repo: 42, branch: "main" } },
      { label: "non-object value", value: ["https://github.com/acme/tree.git"] },
    ] as const;

    const expected = new Map<
      string,
      {
        label: string;
        value: unknown;
        version: number;
        updatedBy: string;
        updatedAtChanges: boolean;
      }
    >();

    for (const fixture of fixtures) {
      const organization = await createOrganization(app.db, {
        name: `backfill-${randomUUID()}`,
        displayName: `${fixture.label} Team`,
      });
      if ("gitlabInstanceOrigin" in fixture) {
        await app.db.insert(gitlabConnections).values({
          id: uuidv7(),
          organizationId: organization.id,
          displayName: `${fixture.label} connection`,
          instanceOrigin: fixture.gitlabInstanceOrigin,
          tokenHash: `backfill-${randomUUID()}`,
        });
      }
      await app.db.execute(sql`
        INSERT INTO organization_settings
          (organization_id, namespace, value, version, updated_by, updated_at)
        VALUES
          (${organization.id}, 'context_tree', ${JSON.stringify(fixture.value)}::jsonb, 7,
           ${admin.userId}, ${oldUpdatedAt.toISOString()}::timestamptz)
      `);

      const value: unknown = fixture.value;
      const recordValue = isRecord(value) ? value : null;
      const repo = typeof recordValue?.repo === "string" ? recordValue.repo : undefined;
      const storedProvider =
        recordValue?.provider === "github" || recordValue?.provider === "gitlab" ? recordValue.provider : undefined;
      const hasProviderKey = recordValue !== null && Object.hasOwn(recordValue, "provider");
      const storage = orgContextTreeStorageSchema.safeParse(recordValue);
      const activeBinding = storage.success ? contextTreeActiveBindingSchema.safeParse(storage.data) : null;
      const resolution = resolveContextTreeProvider({
        repo,
        declaredProvider: storedProvider,
        gitlabInstanceOrigin: "gitlabInstanceOrigin" in fixture ? fixture.gitlabInstanceOrigin : undefined,
      });
      const shouldBackfill = !hasProviderKey && activeBinding?.success === true && resolution.provider !== null;
      expected.set(organization.id, {
        label: fixture.label,
        value: shouldBackfill && recordValue ? { ...recordValue, provider: resolution.provider } : fixture.value,
        version: shouldBackfill ? 8 : 7,
        updatedBy: admin.userId,
        updatedAtChanges: shouldBackfill,
      });
    }

    await app.db.execute(sql.raw(migrationSql));

    const firstRun = await app.db
      .select({
        organizationId: organizationSettings.organizationId,
        value: organizationSettings.value,
        version: organizationSettings.version,
        updatedBy: organizationSettings.updatedBy,
        updatedAt: organizationSettings.updatedAt,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.namespace, "context_tree"));
    expect(firstRun).toHaveLength(fixtures.length);
    for (const row of firstRun) {
      const fixture = expected.get(row.organizationId);
      expect(fixture, row.organizationId).toBeDefined();
      expect(row.value, fixture?.label).toEqual(fixture?.value);
      expect(row.version, fixture?.label).toBe(fixture?.version);
      expect(row.updatedBy, fixture?.label).toBe(fixture?.updatedBy);
      if (fixture?.updatedAtChanges) {
        expect(row.updatedAt.getTime(), fixture.label).toBeGreaterThan(oldUpdatedAt.getTime());
      } else {
        expect(row.updatedAt, fixture?.label).toEqual(oldUpdatedAt);
      }
    }

    await app.db.execute(sql.raw(migrationSql));
    const secondRun = await app.db
      .select({
        organizationId: organizationSettings.organizationId,
        value: organizationSettings.value,
        version: organizationSettings.version,
        updatedBy: organizationSettings.updatedBy,
        updatedAt: organizationSettings.updatedAt,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.namespace, "context_tree"));
    expect(secondRun).toEqual(firstRun);
  });
});
