/**
 * Presentation for a chat's scheduled jobs. The server hands back a cron
 * expression and the next fire time; a reader wants to know when it runs next
 * and whether it is still armed, not to parse cron in their head.
 */
export function formatNextRun(nextRunAt: string | null, now: number = Date.now()): string {
  if (!nextRunAt) return "Not scheduled";
  const at = Date.parse(nextRunAt);
  if (Number.isNaN(at)) return "Not scheduled";
  const delta = at - now;
  if (delta <= 0) return "Due now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `Next in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Next in ${hours}h`;
  return `Next in ${Math.round(hours / 24)}d`;
}

/** A paused schedule is not going to run, whatever its next-run time says. */
export function scheduleStateLabel(state: string): string | null {
  switch (state) {
    case "paused":
      return "Paused";
    case "deleted":
      return "Deleted";
    default:
      return null;
  }
}

/** "owner/repo#42 · open" — the entity's identity and live state in one line. */
export function formatEntitySubtitle(entity: { entityKey: string; state: string | null }): string {
  return entity.state ? `${entity.entityKey} · ${entity.state}` : entity.entityKey;
}
