import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";

type OnboardingCompletionDb = Pick<Database, "select" | "update">;

export type OnboardingCompletionStamp = {
  completedAt: Date;
  newlyCompleted: boolean;
};

type ConditionalStampOptions = {
  condition: SQL;
};

/** The only writer for the membership onboarding-completion invariant. */
export function stampOnboardingCompleted(
  db: OnboardingCompletionDb,
  memberId: string,
  now?: Date,
): Promise<OnboardingCompletionStamp>;
export function stampOnboardingCompleted(
  db: OnboardingCompletionDb,
  memberId: string,
  now: Date,
  options: ConditionalStampOptions,
): Promise<OnboardingCompletionStamp | null>;
export async function stampOnboardingCompleted(
  db: OnboardingCompletionDb,
  memberId: string,
  now = new Date(),
  options?: ConditionalStampOptions,
): Promise<OnboardingCompletionStamp | null> {
  const [completed] = await db
    .update(members)
    .set({
      onboardingCompletedAt: now,
      onboardingSuppressedAt: now,
      onboardingSuppressedReason: "completed",
    })
    .where(and(eq(members.id, memberId), isNull(members.onboardingCompletedAt), options?.condition))
    .returning({ completedAt: members.onboardingCompletedAt });
  if (completed?.completedAt) {
    return { completedAt: completed.completedAt, newlyCompleted: true };
  }

  const [existing] = await db
    .select({ completedAt: members.onboardingCompletedAt })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  if (!existing?.completedAt) {
    if (options) return null;
    throw new Error(`Membership "${memberId}" disappeared while stamping onboarding completion`);
  }
  return { completedAt: existing.completedAt, newlyCompleted: false };
}
