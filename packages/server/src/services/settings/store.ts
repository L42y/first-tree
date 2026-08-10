import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { organizationSettings } from "../../db/schema/organization-settings.js";
import { organizations } from "../../db/schema/organizations.js";
import { NotFoundError } from "../../errors.js";

/** Read the raw JSON value without conflating JSON null with a missing row. */
export async function getRawOrgSettingValue(
  db: Database,
  orgId: string,
  namespace: string,
): Promise<{ value: unknown } | null> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)))
    .limit(1);
  return row ? { value: row.value } : null;
}

/** Serialize settings mutations by locking the stable organization parent row. */
export async function lockOrganizationForSettingsMutation(db: Database, orgId: string): Promise<void> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update")
    .limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${orgId}" not found`);
  }
}
