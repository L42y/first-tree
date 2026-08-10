import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { members } from "../../db/schema/members.js";

/**
 * Pick the user's default Team membership. The most recently created active
 * membership wins, with uuidv7 lexical order as the deterministic tie-break.
 */
export function pickDefaultMembership<T extends { id: string; createdAt: Date }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    if (t !== 0) return t;
    return b.id.localeCompare(a.id);
  });
  return sorted[0] ?? null;
}

/** Resolve the default active Team for user-scoped routes. */
export async function resolveUserPrimaryOrgId(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: members.id,
      organizationId: members.organizationId,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")));
  return pickDefaultMembership(rows)?.organizationId ?? null;
}
